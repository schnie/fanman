import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DataAdapter, CachedRankings } from './data/adapter'
import { picksByPlayer, summarize } from './domain/budget'
import {
  emptyDraft,
  migrateSettings,
  type DraftState,
  type Pick,
  type Player,
  type Settings,
} from './domain/types'

export function useDraft(adapter: DataAdapter) {
  const [state, setState] = useState<DraftState>(() => emptyDraft())
  const [loaded, setLoaded] = useState(false)

  // Rehydrate before the first save, so an empty initial state can't clobber a
  // draft already in progress.
  useEffect(() => {
    adapter.loadDraft().then((saved) => {
      if (saved) setState(migrateSettings(saved))
      setLoaded(true)
    })
  }, [adapter])

  useEffect(() => {
    if (loaded) adapter.saveDraft(state)
  }, [state, loaded, adapter])

  const picks = useMemo(() => picksByPlayer(state), [state])
  const summary = useMemo(() => summarize(state), [state])

  const append = useCallback((pick: Pick) => {
    setState((prev) => ({ ...prev, log: [...prev.log, pick] }))
  }, [])

  /**
   * `price` is what the player actually sold for, when we caught it. 0 means
   * unknown, and the room's spend is estimated from the market average
   * instead — so crossing someone off stays a single tap.
   */
  const markGone = useCallback(
    (playerId: number, price = 0) =>
      append({ playerId, status: 'gone', price, at: Date.now() }),
    [append],
  )

  const markMine = useCallback(
    (playerId: number, price: number) =>
      append({ playerId, status: 'mine', price, at: Date.now() }),
    [append],
  )

  /** Pops the last entry. The log is append-only, so this is always safe. */
  const undo = useCallback(() => {
    setState((prev) => ({ ...prev, log: prev.log.slice(0, -1) }))
  }, [])

  const clearPlayer = useCallback((playerId: number) => {
    setState((prev) => ({ ...prev, log: prev.log.filter((p) => p.playerId !== playerId) }))
  }, [])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }))
  }, [])

  const resetDraft = useCallback(() => {
    setState((prev) => emptyDraft(prev.settings))
  }, [])

  return {
    state,
    loaded,
    picks,
    summary,
    markGone,
    markMine,
    undo,
    clearPlayer,
    updateSettings,
    resetDraft,
  }
}

export function useRankings(adapter: DataAdapter, scoring: Settings['scoring']) {
  const [players, setPlayers] = useState<Player[]>([])
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  /**
   * The book the board in `players` was actually fetched with, which is not
   * always the one in Settings.
   *
   * Changing the setting starts a refetch; it does not change the rows already
   * on screen, and a refetch that fails leaves them there — deliberately, since
   * an empty board mid-auction is the failure this app is built to avoid. But
   * every price we derive is only meaningful in the book its inputs came from,
   * so the board and its book travel together and the UI reads *this*, never
   * the setting. Null until a board lands, when there is nothing to price.
   */
  const [boardScoring, setBoardScoring] = useState<Settings['scoring'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fresh = await adapter.fetchRankings(scoring)
      const cached: CachedRankings = { players: fresh, scoring, fetchedAt: Date.now() }
      setPlayers(fresh)
      setFetchedAt(cached.fetchedAt)
      setBoardScoring(scoring)
      // Persist after painting. Writing is a synchronous stringify + setItem,
      // and nothing until the next cold start depends on it finishing.
      void adapter.saveRankings(cached)
    } catch (err) {
      // A failed refresh must never empty the board — we keep showing whatever
      // we already had and just surface the staleness.
      setError(err instanceof Error ? err.message : 'Could not reach ESPN')
    } finally {
      setLoading(false)
    }
  }, [adapter, scoring])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cached = await adapter.loadRankings()
      if (!cancelled && cached && cached.scoring === scoring) {
        setPlayers(cached.players)
        setFetchedAt(cached.fetchedAt)
        setBoardScoring(cached.scoring)
        setLoading(false)
      }
      if (!cancelled) refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [adapter, scoring, refresh])

  return { players, boardScoring, fetchedAt, loading, error, refresh }
}
