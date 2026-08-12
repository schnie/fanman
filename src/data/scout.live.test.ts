import { describe, it, expect } from 'vitest'
import { scoutPlayer } from './scout'
import type { Player } from '../domain/types'

/**
 * Makes a real, billed Claude call with live web search.
 *
 *     ANTHROPIC_API_KEY=sk-ant-… npm run test:scout
 *
 * Worth running once when you first add a key, and again the morning of the
 * draft. It is the only way to confirm the one thing that could not be verified
 * offline: whether structured outputs and the server-side search tool cooperate.
 * If the schema is being ignored, the tolerant parser still produces a report —
 * this test would pass but `notes`/`sources` would likely come back empty.
 */
const key = process.env.ANTHROPIC_API_KEY
const live = key ? describe : describe.skip

const target: Player = {
  id: 4429795,
  name: 'Jahmyr Gibbs',
  position: 'RB',
  proTeamId: 8,
  rank: 1,
  espnValue: 57,
  marketValue: 64,
  marketChange: 0,
  adp: 1.6,
  percentOwned: 99.9,
  injuryStatus: 'ACTIVE',
  injured: false,
  projectedPoints: 366,
}

live('scout against the real API', () => {
  it('returns a usable verdict with sources', { timeout: 120_000 }, async () => {
    const started = Date.now()
    const report = await scoutPlayer(key!, target)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)

    expect(['GREEN', 'CAUTION', 'RED']).toContain(report.verdict)
    expect(report.playerId).toBe(target.id)
    expect(report.headline.length).toBeGreaterThan(0)
    expect(report.notes.length).toBeLessThanOrEqual(3)

    console.log(`\n  ${report.verdict} — ${report.headline}`)
    for (const note of report.notes) console.log(`   • ${note}`)
    for (const s of report.sources) console.log(`   ↗ ${s.title} ${s.url}`)
    console.log(`  (${seconds}s)\n`)

    // Latency is the whole reason the queue pre-warms rather than fetching on
    // demand. If this ever drops under a couple of seconds, revisit that.
    console.log(`  sources returned: ${report.sources.length}`)
  })
})
