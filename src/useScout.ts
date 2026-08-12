import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataAdapter } from './data/adapter'
import { isScoutError } from './data/scoutError'
import { mapRemove, mapSet, setAdd, setRemove } from './lib/collections'
import type { Pick, Player, ScoutReport } from './domain/types'

/** Two at a time: enough to keep the queue moving, far short of a rate limit. */
const CONCURRENCY = 2

/**
 * How long a cached report is still worth showing.
 *
 * Long enough to cover a whole draft plus the morning's prep, so a refresh
 * mid-draft costs nothing. Short enough that reopening the app days later
 * doesn't present week-old news as current — which is worse than no news,
 * because the whole point of the check is recency.
 */
export const REPORT_TTL_MS = 12 * 60 * 60 * 1000

export function isFresh(report: ScoutReport | undefined, now = Date.now()): boolean {
  return Boolean(report && now - report.fetchedAt < REPORT_TTL_MS)
}

/**
 * Runs scout reports and keeps them warm.
 *
 * A search-backed call takes 10-30s, which is far longer than the gap between
 * a name being called and the bidding closing. So the top of the board is
 * scouted in the background *before* anyone nominates, and a manual request
 * only ever fills a gap.
 */
export function useScout(
  adapter: DataAdapter,
  players: Player[],
  picks: Map<number, Pick>,
  prewarmDepth: number,
) {
  const [reports, setReports] = useState<Map<number, ScoutReport>>(new Map())
  const [pending, setPending] = useState<Set<number>>(new Set())
  const [errors, setErrors] = useState<Map<number, string>>(new Map())
  const [calls, setCalls] = useState(0)
  const [hasKey, setHasKey] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const queue = useRef<Player[]>([])
  /**
   * Dispatch bookkeeping, split so neither can leak.
   *
   * These track only what is *in flight or waiting* — never what has already
   * been scouted. A single "have we scouted this?" set had to be hand-cleared
   * when a key changed or a re-check was requested, and every one of those
   * clears was a path to paying for a report we already held.
   * Whether a player still needs one is derived from `reports` instead.
   */
  const queued = useRef(new Set<number>())
  const running = useRef(new Set<number>())
  const isDispatched = useCallback(
    (id: number) => queued.current.has(id) || running.current.has(id),
    [],
  )

  useEffect(() => {
    adapter.loadApiKey().then((k) => setHasKey(Boolean(k)))
  }, [adapter])

  // Rehydrate before anything can queue, so restored reports suppress the
  // pre-warm that would otherwise re-buy them.
  useEffect(() => {
    let cancelled = false
    adapter.loadScoutReports().then((saved) => {
      if (cancelled) return
      setReports(new Map(saved.filter((r) => isFresh(r)).map((r) => [r.playerId, r])))
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [adapter])

  // Persist on every change. The payload is a few KB at most, and losing an
  // hour of reports to a reload is the expensive failure here.
  useEffect(() => {
    if (!loaded) return
    void adapter.saveScoutReports([...reports.values()])
  }, [reports, loaded, adapter])

  // `run` finishes by pumping the queue and `pump` starts runs, so one of them
  // has to be reached indirectly. A ref breaks the cycle without making either
  // callback unstable.
  const runRef = useRef<(player: Player) => void>(() => {})

  const pump = useCallback(() => {
    while (running.current.size < CONCURRENCY && queue.current.length > 0) {
      const next = queue.current.shift()!
      queued.current.delete(next.id)
      running.current.add(next.id)
      runRef.current(next)
    }
  }, [])

  const run = useCallback(
    async (player: Player) => {
      setPending((prev) => setAdd(prev, player.id))
      try {
        const report = await adapter.scoutPlayer(player)
        setReports((prev) => mapSet(prev, player.id, report))
        setErrors((prev) => mapRemove(prev, player.id))
        setCalls((n) => n + 1)
      } catch (err) {
        const authFailure = isScoutError(err) && err.kind === 'auth'
        setErrors((prev) =>
          mapSet(prev, player.id, err instanceof Error ? err.message : 'Scout failed'),
        )
        // A missing or rejected key fails identically for every player, so stop
        // rather than working through the board reproducing one error. It also
        // never reached the API, so it doesn't count against spend.
        if (authFailure) {
          queue.current = []
          queued.current.clear()
          setHasKey(false)
        } else {
          setCalls((n) => n + 1)
        }
      } finally {
        setPending((prev) => setRemove(prev, player.id))
        running.current.delete(player.id)
        pump()
      }
    },
    [adapter, pump],
  )

  useEffect(() => {
    runRef.current = (player) => void run(player)
  }, [run])

  const enqueue = useCallback(
    (targets: Player[], front = false) => {
      const fresh = targets.filter((p) => !isDispatched(p.id))
      if (fresh.length === 0) return
      for (const p of fresh) queued.current.add(p.id)
      queue.current = front ? [...fresh, ...queue.current] : [...queue.current, ...fresh]
      pump()
    },
    [pump, isDispatched],
  )

  /**
   * Manual request from the player row — jumps the queue and deliberately
   * ignores an existing report, since this is how you refresh a stale one.
   */
  const scoutNow = useCallback(
    (player: Player) => {
      if (isDispatched(player.id)) return // already coming; don't pay twice
      setErrors((prev) => mapRemove(prev, player.id))
      enqueue([player], true)
    },
    [enqueue, isDispatched],
  )

  /** Wipe cached reports — wired to the draft reset, which starts a new draft. */
  const clearReports = useCallback(() => {
    queue.current = []
    queued.current.clear() // in-flight calls are left to finish and clean up
    setReports(new Map())
    setErrors(new Map())
    void adapter.saveScoutReports([])
  }, [adapter])

  // Keep the top of the available board warm. Runs whenever a pick changes who
  // is at the top, topping the queue up by roughly one player per pick.
  useEffect(() => {
    if (!hasKey || !loaded || prewarmDepth <= 0) return
    const targets = players
      .filter((p) => !picks.has(p.id) && p.rank > 0)
      .slice(0, prewarmDepth)
      .filter((p) => !isFresh(reports.get(p.id)))
    enqueue(targets)
  }, [hasKey, loaded, prewarmDepth, players, picks, reports, enqueue])

  const refreshKey = useCallback(async () => {
    setHasKey(Boolean(await adapter.loadApiKey()))
  }, [adapter])

  return { reports, pending, errors, calls, hasKey, scoutNow, refreshKey, clearReports }
}
