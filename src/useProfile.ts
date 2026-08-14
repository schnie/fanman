import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataAdapter } from './data/adapter'
import { isTeamEntity } from './data/proTeams'
import { mapRemove, mapSet, setAdd, setRemove } from './lib/collections'
import type { Player, PlayerProfile } from './domain/types'

/**
 * How long a cached profile is still worth showing.
 *
 * Unlike a scout report, this is purely a latency budget — profiles are free,
 * so the only thing a refetch costs is a request. Six hours is long enough
 * that reopening the same row through a draft never re-fetches, and short
 * enough that the Rotowire note doesn't go stale across a day.
 */
export const PROFILE_TTL_MS = 6 * 60 * 60 * 1000

export function isProfileFresh(p: PlayerProfile | undefined, now = Date.now()): boolean {
  return Boolean(p && now - p.fetchedAt < PROFILE_TTL_MS)
}

/**
 * Fetches a player's ESPN profile when their row is opened, and remembers it.
 *
 * Strictly lazy: the board is ~230 players and a profile is ~35KB, so pulling
 * them up front would cost megabytes to show a card almost none of them will
 * open. One expanded row means at most one request in flight, which is why
 * there is no queue here — the scout needs one because it pre-warms, this
 * doesn't because it never runs unprompted.
 */
export function useProfile(
  adapter: DataAdapter,
  /** The currently expanded player, or null. The only thing that triggers a fetch. */
  player: Player | null,
  online = true,
) {
  const [profiles, setProfiles] = useState<Map<number, PlayerProfile>>(new Map())
  const [pending, setPending] = useState<Set<number>>(new Set())
  const [errors, setErrors] = useState<Map<number, string>>(new Map())
  const [loaded, setLoaded] = useState(false)

  /** In-flight ids only. What we already hold is derived from `profiles`. */
  const running = useRef(new Set<number>())

  // Rehydrate before anything can fetch, so a cached profile suppresses the
  // request its own row would otherwise fire on open.
  useEffect(() => {
    let cancelled = false
    adapter.loadProfiles().then((saved) => {
      if (cancelled) return
      setProfiles(new Map(saved.filter((p) => isProfileFresh(p)).map((p) => [p.playerId, p])))
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [adapter])

  useEffect(() => {
    if (!loaded) return
    void adapter.saveProfiles([...profiles.values()])
  }, [profiles, loaded, adapter])

  const load = useCallback(
    async (target: Player) => {
      if (running.current.has(target.id)) return
      running.current.add(target.id)
      setPending((prev) => setAdd(prev, target.id))
      try {
        const profile = await adapter.fetchProfile(target.id)
        setProfiles((prev) => mapSet(prev, target.id, profile))
        setErrors((prev) => mapRemove(prev, target.id))
      } catch (err) {
        setErrors((prev) =>
          mapSet(prev, target.id, err instanceof Error ? err.message : 'Profile unavailable'),
        )
      } finally {
        running.current.delete(target.id)
        setPending((prev) => setRemove(prev, target.id))
      }
    },
    [adapter],
  )

  // The whole trigger: a row opened on a player we don't already have.
  useEffect(() => {
    if (!loaded || !online || !player) return
    // D/ST and head coaches have no athlete record — the card falls back to the
    // team crest rather than showing an error for something that can't exist.
    if (isTeamEntity(player.id)) return
    if (isProfileFresh(profiles.get(player.id))) return
    // A failed attempt stays failed until the row is reopened or retried, so a
    // dead endpoint can't spin on one row.
    if (errors.has(player.id)) return
    void load(player)
  }, [loaded, online, player, profiles, errors, load])

  const retry = useCallback(
    (target: Player) => {
      if (!online || isTeamEntity(target.id)) return
      setErrors((prev) => mapRemove(prev, target.id))
      void load(target)
    },
    [load, online],
  )

  // Deliberately not wired to the draft reset: a profile is reference data
  // about a player, not a fact about this draft, and re-fetching it would be
  // pure waste.
  return { profiles, pending, errors, retry }
}
