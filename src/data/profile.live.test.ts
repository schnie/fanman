import { describe, it, expect } from 'vitest'
import { fetchProfile } from './profile'
import { headshotUrl, teamLogoUrl } from './proTeams'

/**
 * Hits ESPN's undocumented athlete endpoints for real. Opt-in so the normal
 * suite stays offline and fast:
 *
 *     npm run test:profile
 *
 * The unit tests pin the normaliser against a frozen fixture, which is exactly
 * what can't catch ESPN renaming a field. This is the canary for that: it
 * asserts the shape we depend on is still the shape we get.
 */
const live = process.env.FANMAN_LIVE ? describe : describe.skip

/** Jahmyr Gibbs — an established starter, so every bio block is populated. */
const GIBBS = 4429795

live('ESPN athlete profile', () => {
  it('returns the bio the card renders', { timeout: 30_000 }, async () => {
    const p = await fetchProfile(GIBBS)

    expect(p.playerId).toBe(GIBBS)
    expect(p.team).toBeTruthy()
    expect(p.college).toBeTruthy()
    // Free-text, so we check the shape rather than the value: these are the
    // fields that would silently go null if ESPN renamed `display*`.
    expect(p.height).toMatch(/\d/)
    expect(p.weight).toMatch(/\d/)
    expect(p.age).toBeGreaterThan(18)
    expect(p.draft).toMatch(/\d{4}/)
    expect(p.experience).toBeTruthy()

    console.log(`${p.team} · ${p.jersey} · ${p.age} · ${p.college} · ${p.draft}`)
  })

  it('returns a stat line with league ranks', { timeout: 30_000 }, async () => {
    const { stats, statsLabel } = await fetchProfile(GIBBS)

    expect(stats.length).toBeGreaterThan(0)
    expect(stats.every((s) => s.label && s.value)).toBe(true)
    // Ranks are what make the numbers mean anything; at least one should carry.
    expect(stats.some((s) => s.rank)).toBe(true)
    console.log(statsLabel, stats.map((s) => `${s.value} ${s.label} (${s.rank})`))
  })

  it('serves the assets we build by hand', { timeout: 30_000 }, async () => {
    // Both URLs are constructed from ids with no API call, so a path change
    // would show up as broken images in the UI and nowhere else.
    for (const url of [headshotUrl(GIBBS)!, teamLogoUrl(8)!]) {
      const res = await fetch(url)
      expect(res.ok, `${url} → ${res.status}`).toBe(true)
    }
  })

  it('404s on D/ST without our guard ever letting it fly', { timeout: 30_000 }, async () => {
    // The guard is the contract; this checks the assumption behind it is still
    // true, i.e. that ESPN has not started publishing D/ST athlete records.
    await expect(fetchProfile(-16034)).rejects.toThrow(/no athlete profile/i)
    const res = await fetch(
      'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/-16034',
    )
    expect(res.ok).toBe(false)
  })
})
