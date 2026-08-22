import { describe, it, expect, afterEach } from 'vitest'
import { formatBuildTime } from './format'

const INSTANT = '2026-08-22T14:00:00.000Z'

/**
 * The same instant as a given zone renders it, in whatever locale is running.
 * Asserting against this rather than against digits ("10:00") is what keeps the
 * test about the *shift* — `timeStyle: 'short'` writes 11:00 PM in en-US and
 * 23:00 in en-GB, so a literal would fail the gate for a contributor whose
 * machine is set to a 24-hour locale, on code they never touched.
 */
const inZone = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone })

/**
 * The build stamp arrives as UTC and has to leave as the clock the phone is
 * showing. Node re-reads `process.env.TZ` on the next `Date` call, so pinning a
 * zone here tests the shift itself rather than restating whatever zone the
 * suite happens to run in.
 */
describe('formatBuildTime', () => {
  const original = process.env.TZ
  afterEach(() => {
    /*
     * `TZ` is normally unset, and assigning `undefined` back would store the
     * literal string "undefined" — an invalid zone, which Node resolves to UTC.
     * Vitest workers share `process.env` across files, so that would quietly
     * pin every later file in the worker to UTC instead of the machine's zone.
     */
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it('renders the instant in the device zone, not UTC', () => {
    process.env.TZ = 'America/New_York'

    const built = formatBuildTime(INSTANT)

    expect(built).toBe(inZone(INSTANT, 'America/New_York'))
    expect(built).not.toBe(inZone(INSTANT, 'UTC'))
    expect(built).not.toMatch(/UTC|GMT|Z$/)
  })

  it('follows the device east as well as west', () => {
    process.env.TZ = 'Asia/Tokyo'

    const built = formatBuildTime(INSTANT)

    // A day ahead of the stamp, where New York was a day behind it.
    expect(built).toBe(inZone(INSTANT, 'Asia/Tokyo'))
    expect(built).not.toBe(inZone(INSTANT, 'America/New_York'))
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
