import { describe, it, expect, afterEach } from 'vitest'
import { formatBuildTime } from './format'

/**
 * The build stamp arrives as UTC and has to leave as the clock the phone is
 * showing. Node re-reads `process.env.TZ` on the next `Date` call, so pinning a
 * zone here tests the shift itself rather than restating whatever zone the
 * suite happens to run in.
 */
describe('formatBuildTime', () => {
  const original = process.env.TZ
  afterEach(() => {
    process.env.TZ = original
  })

  it('renders the instant in the local zone, not UTC', () => {
    process.env.TZ = 'America/New_York'

    const built = formatBuildTime('2026-08-22T14:00:00.000Z')!

    expect(built).toContain('10:00')
    expect(built).toContain('2026')
    expect(built).not.toContain('14:00')
    expect(built).not.toMatch(/UTC|Z$/)
  })

  it('follows the device east as well as west', () => {
    process.env.TZ = 'Asia/Tokyo'

    expect(formatBuildTime('2026-08-22T14:00:00.000Z')).toContain('11:00')
  })

  /*
   * A bundle built before the stamp split, or a shell with no build time to
   * give, must not put "Invalid Date" next to the build number — Settings drops
   * the phrase instead. Same reasoning as the rankings timestamp: say nothing
   * rather than say something wrong.
   */
  it('returns null for anything it cannot read as a moment', () => {
    expect(formatBuildTime('')).toBeNull()
    expect(formatBuildTime('abc1234 · 2026-08-22 10:00Z')).toBeNull()
  })
})
