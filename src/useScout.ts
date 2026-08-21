import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataAdapter } from './data/adapter'
import { isAccountProblem, isScoutError } from './data/scoutError'
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

/**
 * Enough to tell one key from another without keeping the key around. The
 * hook has no other reason to hold a secret in memory, so it doesn't.
 */
function fingerprint(key: string | null): string | null {
  return key ? `${key.length}:${key.slice(-4)}` : null
}

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
  /** Attempting a check with no network just produces a confusing error. */
  online = true,
) {
  const [reports, setReports] = useState<Map<number, ScoutReport>>(new Map())
  const [pending, setPending] = useState<Set<number>>(new Set())
  const [errors, setErrors] = useState<Map<number, string>>(new Map())
  const [calls, setCalls] = useState(0)
  const [hasKey, setHasKey] = useState(false)
  /**
   * Set when a failure was about the account rather than the player — a
   * rejected key, an empty credit balance. It only stops the *pre-warm*, so
   * the board doesn't spend the next minute reproducing one error a row at a
   * time. A manual check is always still allowed: this used to be expressed by
   * clearing `hasKey`, which took the Retry button away with it, and the only
   * way back was re-saving the key or resetting the draft.
   */
  const [paused, setPaused] = useState(false)
  const keyPrint = useRef<string | null>(null)
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
  /**
   * Bumped every time the pre-warm pauses, so a call can tell whether it
   * started before or after the failure that paused it.
   *
   * Without it, two concurrent calls are enough to defeat the pause: the
   * balance runs out, B comes back `billing` and pauses, then A — which
   * started earlier and spent the last of the credit — succeeds and clears
   * the pause, refilling the queue with calls that can only fail.
   */
  const pauseEpoch = useRef(0)
  const isDispatched = useCallback(
    (id: number) => queued.current.has(id) || running.current.has(id),
    [],
  )

  useEffect(() => {
    adapter.loadApiKey().then((k) => {
      keyPrint.current = fingerprint(k)
      setHasKey(Boolean(k))
    })
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
      const startedAt = pauseEpoch.current
      setPending((prev) => setAdd(prev, player.id))
      try {
        const report = await adapter.scoutPlayer(player)
        setReports((prev) => mapSet(prev, player.id, report))
        setErrors((prev) => mapRemove(prev, player.id))
        setCalls((n) => n + 1)
        // A call that started under the current epoch got through, so
        // whatever we paused for is fixed. Only a success lifts the pause,
        // deliberately: lifting it on the *request* would let the pre-warm
        // refill behind a manual retry and pay for the same failure once per
        // row. And only a success from *after* the pause, because one that was
        // already in flight proves nothing about the account now.
        if (startedAt === pauseEpoch.current) setPaused(false)
      } catch (err) {
        const kind = isScoutError(err) ? err.kind : 'other'
        setErrors((prev) =>
          mapSet(prev, player.id, err instanceof Error ? err.message : 'Scout failed'),
        )
        // A key the API rejects, or an account with no credit left, fails
        // identically for every player — so drop the queue rather than work
        // through the board reproducing one error. Neither was billed, so
        // neither counts against spend.
        if (isAccountProblem(kind)) {
          queue.current = []
          queued.current.clear()
          pauseEpoch.current += 1
          setPaused(true)
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
      if (!online) return
      if (!hasKey) return // nothing to send; the panel offers Settings instead
      if (isDispatched(player.id)) return // already coming; don't pay twice
      setErrors((prev) => mapRemove(prev, player.id))
      enqueue([player], true)
    },
    [enqueue, hasKey, isDispatched, online],
  )

  /** Wipe cached reports — wired to the draft reset, which starts a new draft. */
  const clearReports = useCallback(() => {
    queue.current = []
    queued.current.clear() // in-flight calls are left to finish and clean up
    setReports(new Map())
    setErrors(new Map())
    setPaused(false)
    void adapter.saveScoutReports([])
  }, [adapter])

  // Keep the top of the available board warm. Runs whenever a pick changes who
  // is at the top, topping the queue up by roughly one player per pick.
  useEffect(() => {
    if (!hasKey || paused || !loaded || !online || prewarmDepth <= 0) return
    const targets = players
      .filter((p) => !picks.has(p.id) && p.rank > 0)
      .slice(0, prewarmDepth)
      .filter((p) => !isFresh(reports.get(p.id)))
    enqueue(targets)
  }, [hasKey, paused, loaded, online, prewarmDepth, players, picks, reports, enqueue])

  const refreshKey = useCallback(async () => {
    const key = await adapter.loadApiKey()
    const print = fingerprint(key)
    // A *different* key is new information about the account and the fix for
    // the commonest pause, so the pre-warm may try again rather than making
    // the user tap a row. Saving the same key back — the reflex when a draft
    // stalls — tells us nothing, and resuming on it would spend another round
    // of calls reproducing the failure.
    if (key && print !== keyPrint.current) {
      pauseEpoch.current += 1
      setPaused(false)
    }
    keyPrint.current = print
    setHasKey(Boolean(key))
  }, [adapter])

  return { reports, pending, errors, calls, hasKey, paused, scoutNow, refreshKey, clearReports }
}
