import { describe, it, expect } from 'vitest'
import { fetchRankings } from './espn'
import { marketVsBookPct } from '../domain/market'

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
    // The book we actually ship. `normalize` reads
    // `draftRanksByRankType[scoring]` and falls back to 0, so if ESPN ever
    // stops publishing SUPERFLEX the board goes silently unpriced rather than
    // failing — which is precisely what this file exists to catch.
    const board = await fetchRankings('SUPERFLEX', 50)

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

    // The shape check that separates the superflex book from the one-QB ones:
    // starting two quarterbacks pulls them to the top, and ESPN's 2026 board
    // opens on six straight. Under PPR the top twelve contain none at all, so
    // a quiet fallback to the wrong book fails here rather than on draft day.
    const topQbs = ranked.slice(0, 12).filter((p) => p.position === 'QB')
    expect(topQbs.length).toBeGreaterThanOrEqual(3)
    expect(topQbs.every((p) => p.espnValue > 0)).toBe(true)

    // Ranks are sparse in this book — 1, 3, 5, 7, 8, … — so nothing may assume
    // they run consecutively. Sorted, yes; dense, no.
    expect(ranked.at(-1)!.rank).toBeGreaterThanOrEqual(ranked.length)

    // The gap the bid-sheet caveat is measured from, checked against the real
    // board. It is deliberately a loose bound: the point is not the exact
    // figure (~23% as of writing) but that ESPN's market column is still a
    // one-QB average. Should ESPN ever start publishing superflex ownership
    // values this fails — which is the good news we would want to hear, since
    // the caveat and `marketVsBookPct` would both be wrong that day.
    const qbGap = marketVsBookPct(board, 'SUPERFLEX', 'QB')
    expect(qbGap).toBeDefined()
    expect(qbGap!).toBeLessThan(60)
    // The mirror: skill positions read high against the same book, because a
    // format starting two QBs moves money onto them and off everyone else.
    expect(marketVsBookPct(board, 'SUPERFLEX', 'RB')!).toBeGreaterThan(100)
    console.log(
      `market vs superflex book — QB ${qbGap}%, RB ${marketVsBookPct(board, 'SUPERFLEX', 'RB')}%`,
    )

    // --- coaches: unpriced by ESPN, valued by us, and always last ---
    expect(coaches).toHaveLength(32)
    expect(board.slice(-32)).toEqual(coaches)
    expect(coaches.every((c) => c.espnValue === 0 && c.marketValue === 0)).toBe(true)
    expect(coaches.every((c) => (c.derivedValue ?? 0) >= 1)).toBe(true)

    // Strongest team first, and the estimate stays inside the league's range.
    const wins = coaches.map((c) => c.projectedWins ?? 0)
    expect([...wins].sort((a, b) => b - a)).toEqual(wins)
    expect(Math.max(...coaches.map((c) => c.derivedValue!))).toBeLessThanOrEqual(4)

    // --- byes: a separate endpoint, so a separate canary ---
    const withBye = board.filter((p) => p.byeWeek !== undefined)
    expect(withBye.length).toBeGreaterThan(board.length * 0.9)
    expect(withBye.every((p) => p.byeWeek! >= 4 && p.byeWeek! <= 14)).toBe(true)
    // Coaches ride the same team lookup, so a shape change there shows up here.
    expect(coaches.every((c) => c.byeWeek !== undefined)).toBe(true)

    console.log(
      ranked.slice(0, 3).map((p) => `${p.rank} ${p.name} $${p.espnValue}/$${p.marketValue} bye ${p.byeWeek}`),
    )
    console.log(
      coaches.slice(0, 3).map((c) => `~$${c.derivedValue} ${c.name} ${c.projectedWins} projW`),
    )
  })
})
