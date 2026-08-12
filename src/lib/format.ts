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
