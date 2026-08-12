import { describe, it, expect } from 'vitest'
import { fetchRankings } from './espn'

/**
 * Hits ESPN and the FPI endpoint for real. Opt-in so the normal suite stays
 * offline and fast:
 *
 *     npm run test:live
 *
 * Worth running before draft day — it's the canary for either undocumented
 * endpoint changing shape underneath us.
 */
const live = process.env.FANMAN_LIVE ? describe : describe.skip

live('ESPN live endpoints', () => {
  it('returns a ranked, priced board with coaches below it', { timeout: 45_000 }, async () => {
    const board = await fetchRankings('PPR', 50)

    const ranked = board.filter((p) => p.position !== 'HC')
    const coaches = board.filter((p) => p.position === 'HC')

    // --- the ranked, ESPN-priced portion ---
    expect(ranked.length).toBeGreaterThan(40)
    expect(ranked[0].rank).toBe(1)
    expect(ranked[0].name).toBeTruthy()
    expect(ranked.every((p) => p.position !== '—')).toBe(true)
    expect(ranked.filter((p) => p.espnValue > 0).length).toBeGreaterThan(40)

    const ranks = ranked.map((p) => p.rank)
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)

    // --- coaches: unpriced by ESPN, valued by us, and always last ---
    expect(coaches).toHaveLength(32)
    expect(board.slice(-32)).toEqual(coaches)
    expect(coaches.every((c) => c.espnValue === 0 && c.marketValue === 0)).toBe(true)
    expect(coaches.every((c) => (c.derivedValue ?? 0) >= 1)).toBe(true)

    // Strongest team first, and the estimate stays inside the league's range.
    const wins = coaches.map((c) => c.projectedWins ?? 0)
    expect([...wins].sort((a, b) => b - a)).toEqual(wins)
    expect(Math.max(...coaches.map((c) => c.derivedValue!))).toBeLessThanOrEqual(4)

    console.log(
      ranked.slice(0, 3).map((p) => `${p.rank} ${p.name} $${p.espnValue}/$${p.marketValue}`),
    )
    console.log(
      coaches.slice(0, 3).map((c) => `~$${c.derivedValue} ${c.name} ${c.projectedWins} projW`),
    )
  })
})
