import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  marketTrend,
  marketPremium,
  isUnpriced,
  MARKET_TREND_THRESHOLD,
  type Player,
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
    expect(marketPremium(player({ espnValue: 57, marketValue: 64 }))).toBe(7)
    expect(marketPremium(player({ espnValue: 45, marketValue: 36.8 }))).toBe(-8.2)
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
