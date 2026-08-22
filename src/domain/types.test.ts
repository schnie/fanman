import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  marketTrend,
  marketIsComparable,
  marketPremium,
  migrateSettings,
  isUnpriced,
  MARKET_TREND_THRESHOLD,
  type DraftState,
  type Player,
  type Scoring,
} from './types'
import { STARTER_SLOTS } from './lineup'
import { makePlayer } from '../test/factories'

const player = (over: Partial<Player> = {}): Player => makePlayer(over)

describe('DEFAULT_SETTINGS', () => {
  it('is the league we actually draft in', () => {
    // Pinned because these leak into the end-to-end expectations in
    // App.dom.test.tsx as bare numbers — an opening max bid of $186 is
    // 200 - (15 - 1). Changing a default here should fail HERE first, with a
    // pointer, rather than as six unexplained dollar amounts over there.
    expect(DEFAULT_SETTINGS.budget).toBe(200)
    expect(DEFAULT_SETTINGS.slots).toBe(15)
    expect(DEFAULT_SETTINGS.teamCount).toBe(12)
    expect(DEFAULT_SETTINGS.prewarmDepth).toBe(5)
    // Superflex: the scoring here is the one thing that changes which auction
    // values ESPN hands back, so a wrong default prices the whole board before
    // anyone opens Settings. It has to agree with STARTER_SLOTS, whose OP slot
    // takes a quarterback — under a one-QB book Josh Allen prices at $22 and
    // ranks 36th, against $59 and 1st in the book this league actually plays.
    expect(DEFAULT_SETTINGS.scoring).toBe('SUPERFLEX')
  })

  it('leaves room for every starting slot plus a bench', () => {
    // Fewer slots than starters would render a lineup with positions missing
    // and no bench at all, which the roster view has no way to explain.
    expect(DEFAULT_SETTINGS.slots).toBeGreaterThan(STARTER_SLOTS.length)
  })

  it('does not pre-scout more players than a nomination turns over', () => {
    // Each one is a paid call fired without being asked for, so the default
    // stays conservative; the dial goes to 40 for anyone who wants it.
    expect(DEFAULT_SETTINGS.prewarmDepth).toBeLessThanOrEqual(10)
  })
})

describe('marketPremium', () => {
  it('is market minus book, from the bidder\'s side', () => {
    expect(marketPremium(player({ espnValue: 57, marketValue: 64 }), 'PPR')).toBe(7)
    expect(marketPremium(player({ espnValue: 45, marketValue: 36.8 }), 'PPR')).toBe(-8.2)
  })

  // The two sides come from different books under SUPERFLEX: `espnValue`
  // follows the format, `marketValue` is ESPN's one cross-league average and
  // does not. Subtracting them yields a number about the gap between two
  // rulebooks, which would render as a market judgement about the player.
  it('has no answer under SUPERFLEX, and says so with undefined', () => {
    // Josh Allen's real 2026 figures: $59 in the superflex book, $31.3 average.
    expect(marketPremium(player({ espnValue: 59, marketValue: 31.3 }), 'SUPERFLEX')).toBeUndefined()
  })

  // Not zero — zero is a real reading ("priced exactly at book") and the
  // callers that sort on this have to tell the two apart.
  it('is undefined rather than zero, so no signal is distinct from no premium', () => {
    expect(marketPremium(player({ espnValue: 40, marketValue: 40 }), 'PPR')).toBe(0)
    expect(marketPremium(player({ espnValue: 40, marketValue: 40 }), 'SUPERFLEX')).toBeUndefined()
  })
})

describe('marketIsComparable', () => {
  it('holds for the one-QB books and fails for superflex', () => {
    expect(marketIsComparable('PPR')).toBe(true)
    expect(marketIsComparable('STANDARD')).toBe(true)
    expect(marketIsComparable('SUPERFLEX')).toBe(false)
  })
})

describe('migrateSettings', () => {
  const saved = (scoring: Scoring, log: DraftState['log'] = []): DraftState => ({
    settings: { ...DEFAULT_SETTINGS, scoring },
    log,
  })

  // A changed DEFAULT_SETTINGS only reaches a device with nothing stored. Every
  // phone that opened the app last season has STANDARD written into its draft
  // and would keep reading the one-QB book forever.
  it('moves a stored one-QB book onto superflex before the draft opens', () => {
    expect(migrateSettings(saved('STANDARD')).settings.scoring).toBe('SUPERFLEX')
    expect(migrateSettings(saved('PPR')).settings.scoring).toBe('SUPERFLEX')
  })

  // Switching the book invalidates the cached board, so the next paint has
  // nothing until a refetch lands — and this app exists because draft-day wifi
  // is not worth betting the board on. Mid-draft the user chooses the moment,
  // in Settings.
  it('leaves a draft in progress alone, board and all', () => {
    const started = saved('STANDARD', [{ playerId: 1, status: 'mine', price: 40, at: 0 }])
    expect(migrateSettings(started)).toBe(started)
  })

  it('returns the same object when there is nothing to correct', () => {
    const already = saved('SUPERFLEX')
    expect(migrateSettings(already)).toBe(already)
  })

  it('changes nothing but the book', () => {
    const before = saved('STANDARD')
    const after = migrateSettings(before)
    expect(after.log).toEqual(before.log)
    expect({ ...after.settings, scoring: 'STANDARD' }).toEqual(before.settings)
  })
})

describe('marketTrend', () => {
  it('flags a clearly rising price', () => {
    expect(marketTrend(player({ marketChange: 0.14 }))).toBe('up')
  })

  it('flags a clearly falling price', () => {
    expect(marketTrend(player({ marketChange: -0.12 }))).toBe('down')
  })

  it('stays silent on day-to-day noise', () => {
    // Median drift across a live board is ~0.03; flagging that would put an
    // arrow on half the players and mean nothing.
    expect(marketTrend(player({ marketChange: 0.03 }))).toBeNull()
    expect(marketTrend(player({ marketChange: -0.03 }))).toBeNull()
    expect(marketTrend(player({ marketChange: 0 }))).toBeNull()
  })

  it('treats the threshold itself as movement', () => {
    expect(marketTrend(player({ marketChange: MARKET_TREND_THRESHOLD }))).toBe('up')
    expect(marketTrend(player({ marketChange: -MARKET_TREND_THRESHOLD }))).toBe('down')
  })

  it('never flags a trend on a player with no market price at all', () => {
    // Coaches carry marketChange 0, but guard regardless: a trend on something
    // with no price is meaningless.
    const coach = player({ espnValue: 0, marketValue: 0, marketChange: 0.5 })
    expect(isUnpriced(coach)).toBe(true)
    expect(marketTrend(coach)).toBeNull()
  })
})
