/**
 * Immutable Set/Map edits for React state.
 *
 * Each returns the *same* instance when nothing would change, so a no-op update
 * doesn't allocate or trigger a re-render. Hand-rolling these inline is what
 * let one copy quietly drift and lose that short-circuit.
 */

export function setAdd<T>(set: Set<T>, value: T): Set<T> {
  if (set.has(value)) return set
  return new Set(set).add(value)
}

export function setRemove<T>(set: Set<T>, value: T): Set<T> {
  if (!set.has(value)) return set
  const next = new Set(set)
  next.delete(value)
  return next
}

export function mapSet<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> {
  return new Map(map).set(key, value)
}

export function mapRemove<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}
