import { describe, it, expect } from 'vitest'
import { buildChatContext, buildLive, buildReference } from './chatContext'
import type { ChatContextInput } from './chatContext'
import { summarize, picksByPlayer } from './budget'
import { summarizeMarket } from './market'
import { suggestNomination } from './nomination'
import { DEFAULT_SETTINGS, emptyDraft, type Pick, type Player, type Settings } from './types'
import { makePlayer } from '../test/factories'

const ABBR: Record<number, string> = { 1: 'ATL', 2: 'BUF', 3: 'CHI' }
const teamAbbr = (id: number) => ABBR[id] ?? null

const BOARD: Player[] = [
  makePlayer({ id: 1, name: 'Jahmyr Gibbs', position: 'RB', rank: 1, espnValue: 52, marketValue: 55, byeWeek: 8, proTeamId: 1 }),
  makePlayer({ id: 2, name: 'Puka Nacua', position: 'WR', rank: 2, espnValue: 44, marketValue: 41, byeWeek: 9, proTeamId: 2 }),
  makePlayer({ id: 3, name: 'Josh Allen', position: 'QB', rank: 3, espnValue: 30, marketValue: 36, byeWeek: 8, proTeamId: 2 }),
  makePlayer({ id: 4, name: 'Bijan Robinson', position: 'RB', rank: 4, espnValue: 40, marketValue: 43, byeWeek: 9, proTeamId: 1 }),
  // No bye fetched for this one — the schedule call fails independently.
  makePlayer({ id: 5, name: 'Trey McBride', position: 'TE', rank: 5, espnValue: 20, marketValue: 22, byeWeek: undefined, proTeamId: 3 }),
  // A head coach: ESPN prices none of them, so this carries our own estimate.
  makePlayer({
    id: -14,
    name: 'Detroit Lions HC',
    position: 'HC',
    rank: 0,
    espnValue: 0,
    marketValue: 0,
    derivedValue: 3,
    projectedWins: 11.2,
    proTeamId: 1,
  }),
]

function build(log: Pick[] = [], settings: Settings = DEFAULT_SETTINGS): ChatContextInput {
  const state = { ...emptyDraft(settings), log }
  const picks = picksByPlayer(state)
  const market = summarizeMarket(BOARD, picks, settings)
  const summary = summarize(state)
  return {
    players: BOARD,
    picks,
    summary,
    settings,
    market,
    advice: suggestNomination({ players: BOARD, picks, summary, settings, market }),
    teamAbbr,
  }
}

const won = (playerId: number, price: number): Pick => ({ playerId, status: 'mine', price, at: 1 })
const gone = (playerId: number, price = 0): Pick => ({ playerId, status: 'gone', price, at: 1 })

describe('buildReference', () => {
  it('states the league setup', () => {
    const ref = buildReference(build())
    expect(ref).toContain('12 teams, $200 auction budget each, 15 roster spots each')
    expect(ref).toContain('Scoring: PPR')
  })

  it('spells out that OP makes this superflex, since the label does not', () => {
    const ref = buildReference(build())
    expect(ref).toMatch(/SUPERFLEX/)
    expect(ref).toContain('under-price QBs')
  })

  it('lists every player, ranked, with team and both values', () => {
    const ref = buildReference(build())
    expect(ref).toContain('#1 | RB | Jahmyr Gibbs | ATL | $52 | $55 | bye8')
    expect(ref).toContain('#3 | QB | Josh Allen | BUF | $30 | $36 | bye8')
  })

  /**
   * The load-bearing one. A number we invented must never read as one ESPN
   * published, and this is the only place in the app where the two are handed
   * to something that will paraphrase them.
   */
  it('marks a derived value with a tilde and says whose it is', () => {
    const ref = buildReference(build())
    expect(ref).toContain('~$3')
    expect(ref).toMatch(/leading `~` is OUR OWN estimate/)
    // Never laundered into a bare dollar figure alongside the published ones.
    expect(ref).not.toContain('| $3 | ')
  })

  it('writes an unfetched bye as nothing at all, never as zero', () => {
    const ref = buildReference(build())
    const line = ref.split('\n').find((l) => l.includes('Trey McBride'))!
    expect(line).not.toMatch(/bye/)
    expect(ref).toContain('does NOT mean they have no bye')
  })

  /**
   * The reference block sits behind the cache breakpoint. Anything clock-
   * dependent in it changes the prefix on every turn, and the cache silently
   * never hits again — the classic invalidator, and invisible from the UI.
   */
  it('is byte-identical across calls, so the cached prefix stays cached', () => {
    const input = build([won(1, 40)])
    expect(buildReference(input)).toBe(buildReference(input))
    expect(buildReference(input)).not.toMatch(/\d{13}/) // no epoch millis
  })

  it('does not move when the draft does — only the live half should', () => {
    expect(buildReference(build())).toBe(buildReference(build([won(1, 40), gone(2, 30)])))
  })
})

describe('buildLive', () => {
  it('states the max bid as a hard ceiling', () => {
    const live = buildLive(build([won(1, 40)]))
    // $200 - $40 = $160 left, 14 slots to go, so $1 held back for 13 of them.
    expect(live).toContain('Max bid right now: $147')
    expect(live).toContain('Never suggest a bid above it')
  })

  it('says plainly when the roster is full rather than quoting a $0 ceiling', () => {
    const settings = { ...DEFAULT_SETTINGS, slots: 2 }
    const live = buildLive(build([won(1, 40), won(2, 30)], settings))
    expect(live).toContain('Our roster is FULL')
    expect(live).not.toContain('Max bid right now')
  })

  it('places won players into their lineup slots with what we paid', () => {
    const live = buildLive(build([won(1, 40), won(3, 25)]))
    expect(live).toContain('RB: Jahmyr Gibbs (RB ATL) — $40, bye 8')
    expect(live).toContain('QB: Josh Allen (QB BUF) — $25, bye 8')
    expect(live).toContain('WR: EMPTY')
  })

  /**
   * Inference is cheap to ask for and expensive to get wrong: suggesting a
   * player who went twenty minutes ago is the one failure that makes this
   * feature worse than not having it.
   */
  it('lists everyone already taken, explicitly, as unavailable', () => {
    const live = buildLive(build([gone(2, 38), gone(4)]))
    expect(live).toContain('these are NOT available, never suggest one')
    expect(live).toContain('Puka Nacua (WR BUF) $38')
    // A cross-off with no price recorded says so rather than reading as free.
    expect(live).toContain('Bijan Robinson (RB ATL) price unknown')
  })

  it('separates what we won from what the room took', () => {
    const live = buildLive(build([won(1, 40), gone(2, 38)]))
    expect(live).toContain('Won by us (1): Jahmyr Gibbs (RB ATL) $40')
    expect(live).toContain('Taken by other teams (1)')
  })

  it('names the slots a bye actually empties, not just the headcount', () => {
    // Two backs, both off in week 9, on a roster with two RB slots.
    const live = buildLive(build([won(4, 30), won(1, 40)]))
    expect(live).toContain('Week 8')
    expect(live).toContain('Week 9')
    expect(live).toMatch(/Leaves \d+ starting slot\(s\) empty/)
  })

  it('says nothing about byes we never fetched', () => {
    const live = buildLive(build([won(5, 12)]))
    expect(live).toContain('Nothing on our roster has a known bye yet')
  })

  it('explains inflation rather than just quoting the multiplier', () => {
    const live = buildLive(build())
    expect(live).toMatch(/Inflation \d\.\d\dx/)
    expect(live).toContain('above the $1 minimum')
  })

  /**
   * The draft log records that a player is gone, never who bought them — so
   * there is no such thing as a fact about a named rival here. Left unsaid, a
   * model will invent one.
   */
  it('frames the rival ceiling as an average and forbids naming a team', () => {
    const live = buildLive(build([gone(1, 40)]))
    expect(live).toContain('AVERAGE across the field')
    expect(live).toContain('Never attribute a purchase or a budget to a named team')
  })

  it('passes the app’s own suggestion through so the two cannot disagree', () => {
    const live = buildLive(build([gone(1, 40)]))
    expect(live).toContain('# The app already suggests')
    expect(live).toContain('do not quietly contradict it')
  })

  it('shortlists what is still available, excluding what is gone', () => {
    const live = buildLive(build([gone(1, 40)]))
    const shortlist = live.slice(live.indexOf('# Best available'))
    expect(shortlist).toContain('Puka Nacua')
    expect(shortlist).not.toContain('Jahmyr Gibbs')
  })
})

describe('buildChatContext', () => {
  it('returns both halves', () => {
    const ctx = buildChatContext(build())
    expect(ctx.reference).toContain('# Board')
    expect(ctx.live).toContain('# Our budget')
  })
})
