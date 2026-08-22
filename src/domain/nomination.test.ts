import { describe, it, expect } from 'vitest'
import { postureFor, suggestNomination, type MoveAdvice } from './nomination'
import { picksByPlayer, summarize } from './budget'
import { summarizeMarket } from './market'
import { DEFAULT_SETTINGS, type DraftState, type Pick, type Player, type Settings } from './types'
import { makePlayer } from '../test/factories'

// Pinned to a one-QB book rather than inherited from DEFAULT_SETTINGS, which
// is SUPERFLEX. Most of what this module decides rides on `marketPremium`, and
// that signal only exists where `espnValue` and `marketValue` come from the
// same book — under superflex it is undefined by design. The tests that cover
// *that* path set `scoring` themselves, so both behaviours stay asserted and
// neither can be turned off by a change to the default.
const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  budget: 200,
  slots: 15,
  teamCount: 12,
  scoring: 'PPR',
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

/**
 * The same, asserted to have produced a suggestion. Most tests are about
 * *which* player gets named, so they'd otherwise all open with the same
 * null-and-kind dance.
 */
function move(players: Player[], log: Pick[] = [], over: Partial<Settings> = {}): MoveAdvice {
  const advice = advise(players, log, over)
  if (advice?.kind !== 'move') {
    throw new Error(`expected a suggestion, got ${advice === null ? 'null' : advice.kind}`)
  }
  return advice
}

describe('posture', () => {
  it('opens the draft by draining: full wallets and a board the sheet under-prices', () => {
    expect(move(board(204)).reason).toBe('rich')
  })

  it('estimates a typical rival at our own ceiling before anyone has spent', () => {
    // Twelve identical teams: the average rival must be us. A model that can't
    // get the symmetric case right can't be trusted on the asymmetric ones.
    const advice = move(board(204))
    expect(advice.rivalMaxBid).toBe(advice.maxBid)
  })

  it('switches to buying once we are outgunned by the field', () => {
    const advice = move(board(204), [mine(1, 150)])
    expect(advice.reason).toBe('behind')
    expect(advice.maxBid).toBeLessThan(advice.rivalMaxBid)
  })

  it('switches to buying when inflation falls back to par', () => {
    // A richly-valued board: listed value outruns the money, so everything left
    // is a bargain and feeding the room more players donates that value away.
    expect(move(board(204, 200)).reason).toBe('bargains')
  })

  it('calls the endgame once rivals are down to $1 bids', () => {
    const advice = move(board(10), [gone(1, 99)], { teamCount: 2, slots: 2, budget: 100 })
    expect(advice.reason).toBe('endgame')
    expect(advice.rivalMaxBid).toBeLessThanOrEqual(1)
  })

  it('never risks the last slot on a player we do not want', () => {
    expect(move(board(204), [mine(200, 1)], { slots: 2 }).reason).toBe('lastSlot')
  })

  it('maps every reason but "rich" onto buying', () => {
    // The one place the posture is decided, so the one place it is asserted.
    expect(postureFor('rich')).toBe('drain')
    for (const reason of ['behind', 'bargains', 'endgame', 'lastSlot'] as const) {
      expect(postureFor(reason)).toBe('buy')
    }
  })

  it('says nothing at all with a full roster', () => {
    // The budget bar already announces it; a second notice costs phone height.
    expect(advise(board(204), [mine(200, 1)], { slots: 1 })).toBeNull()
  })

  it('says nothing before the board has loaded', () => {
    expect(advise([])).toBeNull()
  })

  it('goes idle rather than inventing a suggestion when nothing is left', () => {
    const players = board(3)
    expect(advise(players, players.map((p) => gone(p.id)))?.kind).toBe('idle')
  })
})

describe('draining', () => {
  it('puts up the player the room most overpays for, not simply the priciest', () => {
    // P5 lists at $56 but the market is paying $16 over book. That gap is
    // someone else's money being wasted, which is the whole point.
    const players = board(204)
    players[4] = makePlayer({ ...players[4], espnValue: 40 })
    const advice = move(players)
    expect(advice.pick.player.id).toBe(5)
    expect(advice.pick.premium).toBe(16)
  })

  // Under superflex there is no premium to read (`marketPremium` is undefined:
  // book and market come from different books), so the discount planted on P5
  // is invisible and the sort has to fall through to price. That is the right
  // degradation here — absent a known overpay, the priciest body we don't need
  // is still the one that pulls the most money out of the room.
  it('falls back to the priciest body when superflex leaves no premium to read', () => {
    const players = board(204)
    players[4] = makePlayer({ ...players[4], espnValue: 40 })
    const advice = move(players, [], { scoring: 'SUPERFLEX' })
    expect(advice.pick.player.id).toBe(1)
    expect(advice.pick.premium).toBeUndefined()
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
    const advice = move(players, [mine(102, 1), mine(103, 1), mine(104, 1)])
    expect(advice.pick.player.id).toBe(101)
    expect(advice.pick.fillsNeed).toBe(false)
  })

  it('opens under the expected sale price, so getting stuck is a bargain', () => {
    const { pick } = move(board(204))
    expect(pick.openAt).toBeGreaterThanOrEqual(1)
    expect(pick.openAt).toBeLessThan(pick.expected)
  })

  it('never opens above what we could actually pay', () => {
    const advice = move(board(204))
    expect(advice.pick.openAt).toBeLessThanOrEqual(advice.maxBid)
  })

  it('leaves injured players out of the pool — they may not draw the bids', () => {
    const players = board(204)
    for (let i = 0; i < 3; i++) players[i] = makePlayer({ ...players[i], injured: true })
    const advice = move(players)
    expect(advice.pick.player.injured).toBe(false)
  })
})

describe('buying', () => {
  it('opens at $1 — there is no reason to bid against ourselves', () => {
    const advice = move(board(204, 200))
    expect(advice.pick.openAt).toBe(1)
  })

  it('never suggests a player we cannot afford', () => {
    const advice = move(board(204, 200), [mine(1, 185)])
    expect(advice.pick.expected).toBeLessThanOrEqual(advice.maxBid)
  })

  it('takes the tail of the tier — the one the room has priced coolest', () => {
    // Five near-identical players; the fourth is $6 under book. Same player,
    // cheaper name.
    const players = board(204, 200)
    players[3] = makePlayer({ ...players[3], espnValue: 203 })
    const advice = move(players)
    expect(advice.pick.player.id).toBe(4)
    expect(advice.pick.premium).toBe(-6)
  })

  // The mirror of the case above, and the reason the superflex fallback sorts
  // *up* on price rather than reusing the descending tiebreak. The tier is the
  // set of near-identical players; without a premium to pick the coolest, the
  // cheapest is the closest thing to the same intent. Sorting down would hand
  // back the tier leader — precisely the player this branch exists to skip.
  it('takes the cheapest of the tier when superflex leaves no premium to read', () => {
    const players = board(204, 200)
    players[3] = makePlayer({ ...players[3], espnValue: 203 })
    const advice = move(players, [], { scoring: 'SUPERFLEX' })
    expect(advice.pick.premium).toBeUndefined()
    // Still inside the tier, and not its leader.
    // P8 at $193 — the tail of the same tier the premium version walks, just
    // found by price instead of by discount. P4's planted $6 discount is
    // invisible here, which is the point: it isn't a discount, it's two books
    // disagreeing.
    expect(advice.pick.player.id).toBe(8)
  })

  it('walks a real WR ladder to the tail of the tier and stops at the cliff', () => {
    // The live 2026 WR board, market and book values as ESPN published them.
    // Steps run 97%, 97%, 95%, 91%, 97% and then fall to 80% at London — the
    // cliff. Lamb is the tail of the tier above it and the pick. London is a
    // bigger discount ($5.6 under book against Lamb's $3.0) and must lose
    // anyway: he is a worse player, not a cheaper name for the same one.
    const wrs: [string, number, number][] = [
      ["Ja'Marr Chase", 58.48, 56],
      ['Puka Nacua', 56.8, 55],
      ['Jaxon Smith-Njigba', 55.39, 54],
      ['Amon-Ra St. Brown', 52.57, 52],
      ['CeeDee Lamb', 47.99, 51],
      ['Justin Jefferson', 46.77, 48],
      ['Drake London', 37.38, 43],
    ]
    const players = [
      ...wrs.map(([name, mkt, book], i) =>
        makePlayer({ id: i + 1, name, position: 'WR', marketValue: mkt, espnValue: book }),
      ),
      // Bulk to keep the room's money and the board's listed value in step, so
      // this lands in the buying posture rather than the draining one.
      ...Array.from({ length: 200 }, (_, i) =>
        makePlayer({ id: i + 100, marketValue: 13, espnValue: 13 }),
      ),
    ]
    const advice = move(players)
    expect(advice.pick.player.name).toBe('CeeDee Lamb')
  })

  it('ignores a discount that would cost real value', () => {
    // A cliff, not a tier: four players in the $200s and then a drop to $100.
    // The cheap one carries the biggest discount on the board — $30 under book
    // — and taking it would still mean handing back $100 of player to save it.
    const players = [
      makePlayer({ id: 1, marketValue: 200, espnValue: 200 }),
      makePlayer({ id: 2, marketValue: 199, espnValue: 199 }),
      makePlayer({ id: 3, marketValue: 198, espnValue: 198 }),
      makePlayer({ id: 4, marketValue: 197, espnValue: 197 }),
      makePlayer({ id: 5, name: 'Big discount', marketValue: 100, espnValue: 130 }),
      ...Array.from({ length: 200 }, (_, i) =>
        makePlayer({ id: i + 10, marketValue: 99, espnValue: 99 }),
      ),
    ]
    const advice = move(players)
    expect(advice.pick.player.id).toBe(1)
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
    const advice = move(players, [mine(2, 1), mine(3, 1), mine(4, 1)])
    // Affordable, and still passed over: it was need that ruled him out.
    expect(advice.pick.expected).toBeLessThan(advice.maxBid)
    expect(advice.pick.player.position).toBe('TE')
    expect(advice.pick.fillsNeed).toBe(true)
  })
})

describe('unpriced players', () => {
  it('never suggests one — we do not quote a price ESPN never published', () => {
    const players = [
      makePlayer({ id: 1, marketValue: 60, espnValue: 60 }),
      makePlayer({ id: 2, name: 'Some HC', position: 'HC', marketValue: 0, espnValue: 0 }),
    ]
    // The head coach is the only player left, and he has no price to quote.
    expect(advise(players, [gone(1)])?.kind).toBe('idle')
  })
})
