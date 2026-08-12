import { describe, it, expect } from 'vitest'
import { marketTrend, marketPremium, isUnpriced, MARKET_TREND_THRESHOLD, type Player } from './types'
import { makePlayer } from '../test/factories'

const player = (over: Partial<Player> = {}): Player => makePlayer(over)

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
