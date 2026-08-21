import { describe, it, expect } from 'vitest'
import { suggestNomination } from './nomination'
import { picksByPlayer, summarize } from './budget'
import { summarizeMarket } from './market'
import { DEFAULT_SETTINGS, type DraftState, type Pick, type Player, type Settings } from './types'
import { makePlayer } from '../test/factories'

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  budget: 200,
  slots: 15,
  teamCount: 12,
  ...over,
})

/**
 * A board of `n` players whose market values descend from `top`. At the default
 * size this lands the room near ×1.25 inflation — close to what a real ESPN
 * board does at the opening nomination, so the "rich" path is the default here
 * for the same reason it is on draft day.
 */
function board(n: number, top = 60): Player[] {
  return Array.from({ length: n }, (_, i) =>
    makePlayer({
      id: i + 1,
      name: `P${i + 1}`,
      rank: i + 1,
      marketValue: Math.max(1, top - i),
      espnValue: Math.max(1, top - i),
    }),
  )
}

const gone = (playerId: number, price = 0): Pick => ({ playerId, status: 'gone', price, at: 0 })
const mine = (playerId: number, price: number): Pick => ({ playerId, status: 'mine', price, at: 0 })

/** Drives the real derivation chain the app uses, so the pieces can't drift apart. */
function advise(players: Player[], log: Pick[] = [], over: Partial<Settings> = {}) {
  const state: DraftState = { settings: settings(over), log }
  const picks = picksByPlayer(state)
  return suggestNomination({
    players,
    picks,
    summary: summarize(state),
    settings: state.settings,
    market: summarizeMarket(players, picks, state.settings),
  })
}

describe('posture', () => {
  it('opens the draft by draining — full wallets and a board the sheet under-prices', () => {
    const advice = advise(board(204))
    expect(advice.posture).toBe('drain')
    expect(advice.reason).toBe('rich')
  })

  it('estimates a typical rival at our own ceiling before anyone has spent', () => {
    // Twelve identical teams: the average rival must be us. A model that can't
    // get the symmetric case right can't be trusted on the asymmetric ones.
    const advice = advise(board(204))
    expect(advice.rivalMaxBid).toBe(advice.maxBid)
  })

  it('switches to buying once we are outgunned by the field', () => {
    const advice = advise(board(204), [mine(1, 150)])
    expect(advice.posture).toBe('buy')
    expect(advice.reason).toBe('behind')
    expect(advice.maxBid).toBeLessThan(advice.rivalMaxBid)
  })

  it('switches to buying when inflation falls back to par', () => {
    // A richly-valued board: listed value outruns the money, so everything left
    // is a bargain and feeding the room more players donates that value away.
    const advice = advise(board(204, 200))
    expect(advice.posture).toBe('buy')
    expect(advice.reason).toBe('bargains')
  })

  it('calls the endgame once rivals are down to $1 bids', () => {
    const advice = advise(board(10), [gone(1, 99)], { teamCount: 2, slots: 2, budget: 100 })
    expect(advice.reason).toBe('endgame')
    expect(advice.rivalMaxBid).toBeLessThanOrEqual(1)
    expect(advice.posture).toBe('buy')
  })

  it('never risks the last slot on a player we do not want', () => {
    const advice = advise(board(204), [mine(200, 1)], { slots: 2 })
    expect(advice.reason).toBe('lastSlot')
    expect(advice.posture).toBe('buy')
  })

  it('goes idle with a full roster', () => {
    const advice = advise(board(204), [mine(200, 1)], { slots: 1 })
    expect(advice.posture).toBe('idle')
    expect(advice.reason).toBe('rosterFull')
    expect(advice.pick).toBeUndefined()
  })

  it('goes idle rather than inventing a suggestion when nothing is left', () => {
    const players = board(3)
    const advice = advise(players, players.map((p) => gone(p.id)))
    expect(advice.posture).toBe('idle')
    expect(advice.reason).toBe('noBoard')
  })
})

describe('draining', () => {
  it('puts up the player the room most overpays for, not simply the priciest', () => {
    // P5 lists at $56 but the market is paying $16 over book. That gap is
    // someone else's money being wasted, which is the whole point.
    const players = board(204)
    players[4] = makePlayer({ ...players[4], espnValue: 40 })
    const advice = advise(players)
    expect(advice.pick?.player.id).toBe(5)
    expect(advice.pick?.premium).toBe(16)
  })

  it('prefers a position we no longer need over a more expensive one we do', () => {
    // Three won RBs fill RB1, RB2 and the OP slot, so RB stops being a need
    // while WR is still open. The cheaper RB is the better nomination.
    const players = [
      ...board(9, 40).map((p) => ({ ...p, position: 'WR' })),
      makePlayer({ id: 100, name: 'Big WR', position: 'WR', marketValue: 60, espnValue: 60 }),
      makePlayer({ id: 101, name: 'Spare RB', position: 'RB', marketValue: 55, espnValue: 55 }),
      makePlayer({ id: 102, name: 'Owned A', position: 'RB', marketValue: 5, espnValue: 5 }),
      makePlayer({ id: 103, name: 'Owned B', position: 'RB', marketValue: 5, espnValue: 5 }),
      makePlayer({ id: 104, name: 'Owned C', position: 'RB', marketValue: 5, espnValue: 5 }),
    ]
    const advice = advise(players, [mine(102, 1), mine(103, 1), mine(104, 1)])
    expect(advice.posture).toBe('drain')
    expect(advice.pick?.player.id).toBe(101)
    expect(advice.pick?.fillsNeed).toBe(false)
  })

  it('opens under the expected sale price, so getting stuck is a bargain', () => {
    const advice = advise(board(204))
    const pick = advice.pick!
    expect(pick.openAt).toBeGreaterThanOrEqual(1)
    expect(pick.openAt).toBeLessThan(pick.expected)
    expect(pick.cushion).toBe(pick.expected - pick.openAt)
  })

  it('never opens above what we could actually pay', () => {
    const advice = advise(board(204))
    expect(advice.pick!.openAt).toBeLessThanOrEqual(advice.maxBid)
  })

  it('leaves injured players out of the pool — they may not draw the bids', () => {
    const players = board(204)
    for (let i = 0; i < 3; i++) players[i] = makePlayer({ ...players[i], injured: true })
    const advice = advise(players)
    expect(advice.pick?.player.injured).toBe(false)
  })
})

describe('buying', () => {
  it('opens at $1 — there is no reason to bid against ourselves', () => {
    const advice = advise(board(204, 200))
    expect(advice.posture).toBe('buy')
    expect(advice.pick?.openAt).toBe(1)
  })

  it('never suggests a player we cannot afford', () => {
    const advice = advise(board(204, 200), [mine(1, 185)])
    expect(advice.pick!.expected).toBeLessThanOrEqual(advice.maxBid)
  })

  it('takes the tail of the tier — the one the room has priced coolest', () => {
    // Five near-identical players; the fourth is $6 under book. Same player,
    // cheaper name.
    const players = board(204, 200)
    players[3] = makePlayer({ ...players[3], espnValue: 203 })
    const advice = advise(players)
    expect(advice.pick?.player.id).toBe(4)
    expect(advice.pick?.premium).toBe(-6)
  })

  it('fills a hole rather than chasing the best player left', () => {
    // The richest player on the board is a WR, and we can afford him — but
    // three won WRs have already filled WR1, WR2 and the OP slot, so he buys
    // us nothing a bench spot wouldn't.
    const players = [
      makePlayer({ id: 1, name: 'Rich WR', position: 'WR', marketValue: 300, espnValue: 300 }),
      makePlayer({ id: 2, name: 'Owned WR A', position: 'WR', marketValue: 5, espnValue: 5 }),
      makePlayer({ id: 3, name: 'Owned WR B', position: 'WR', marketValue: 5, espnValue: 5 }),
      makePlayer({ id: 4, name: 'Owned WR C', position: 'WR', marketValue: 5, espnValue: 5 }),
      ...board(200, 200).map((p) => ({ ...p, id: p.id + 100, position: 'TE' })),
    ]
    const advice = advise(players, [mine(2, 1), mine(3, 1), mine(4, 1)])
    expect(advice.posture).toBe('buy')
    // Affordable, and still passed over: it was need that ruled him out.
    expect(advice.pick!.expected).toBeLessThan(advice.maxBid)
    expect(advice.pick?.player.position).toBe('TE')
    expect(advice.pick?.fillsNeed).toBe(true)
  })
})

describe('unpriced players', () => {
  it('never suggests one — we do not quote a price ESPN never published', () => {
    const players = [
      makePlayer({ id: 1, marketValue: 60, espnValue: 60 }),
      makePlayer({ id: 2, name: 'Some HC', position: 'HC', marketValue: 0, espnValue: 0 }),
    ]
    const advice = advise(players, [gone(1)])
    expect(advice.posture).toBe('idle')
    expect(advice.reason).toBe('noBoard')
  })
})
