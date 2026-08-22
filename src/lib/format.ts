/**
 * CSS-class suffix for a position or slot label. `D/ST` would otherwise emit an
 * invalid class name, so the slash is stripped.
 */
export function posClass(label: string): string {
  return label.replace('/', '')
}

/** Human-readable age of a cached rankings pull. */
export function describeAge(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * A build's ISO instant as the device's own clock reads it.
 *
 * The stamp used to ship pre-formatted in UTC, which is correct and unreadable:
 * the one moment you check it is mid-draft, on a phone, deciding whether the
 * build you are looking at is the one that just deployed — and that comparison
 * is against the clock in the status bar, not against a Z-suffixed time you
 * have to shift by hand.
 *
 * No timezone label: pairing `dateStyle`/`timeStyle` with one is not allowed,
 * and the alternatives either add seconds no one wants or hand-roll the field
 * order for every locale. The time is the reader's own, which is the point.
 *
 * Returns `null` for anything unparseable — a bundle built before the stamp
 * split, or a shell that supplies nothing — so the caller can drop the phrase
 * rather than print "Invalid Date" next to a build number.
 */
export function formatBuildTime(iso: string): string | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
