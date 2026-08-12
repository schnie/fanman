// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useScout, REPORT_TTL_MS } from './useScout'
import type { DataAdapter } from './data/adapter'
import type { Pick, Player, ScoutReport } from './domain/types'
import { makePlayer, makeReport } from './test/factories'
import { ScoutError } from './data/scoutError'

const player = (id: number, rank: number): Player =>
  makePlayer({ id, name: `Player ${id}`, rank, adp: rank })

const BOARD = [player(1, 1), player(2, 2), player(3, 3), player(4, 4), player(5, 5)]

function makeAdapter(over: Partial<DataAdapter> = {}) {
  const scouted: number[] = []
  const store: { saved: ScoutReport[] } = { saved: [] }
  const adapter = {
    async fetchRankings() { return BOARD },
    async loadRankings() { return null },
    async saveRankings() {},
    async loadDraft() { return null },
    async saveDraft() {},
    async loadScoutReports() { return store.saved },
    async saveScoutReports(r: ScoutReport[]) { store.saved = r },
    async loadApiKey() { return 'sk-ant-test' },
    async saveApiKey() {},
    async scoutPlayer(p: Player): Promise<ScoutReport> {
      scouted.push(p.id)
      return makeReport(p.id)
    },
    ...over,
  } as DataAdapter
  return { adapter, scouted, store }
}

const report = (playerId: number, ageMs = 0): ScoutReport =>
  makeReport(playerId, { fetchedAt: Date.now() - ageMs })

const noPicks = new Map<number, Pick>()

describe('useScout', () => {
  it('pre-warms the top N available players', async () => {
    const { adapter, scouted } = makeAdapter()
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 3))

    await waitFor(() => expect(result.current.reports.size).toBe(3))
    expect(scouted.sort()).toEqual([1, 2, 3])
  })

  it('does nothing without an API key', async () => {
    const { adapter, scouted } = makeAdapter({ async loadApiKey() { return null } })
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 3))

    await waitFor(() => expect(result.current.hasKey).toBe(false))
    expect(scouted).toEqual([])
  })

  it('pre-warms nothing at depth 0 but still allows a manual check', async () => {
    const { adapter, scouted } = makeAdapter()
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 0))

    await waitFor(() => expect(result.current.hasKey).toBe(true))
    expect(scouted).toEqual([])

    act(() => result.current.scoutNow(BOARD[4]))
    await waitFor(() => expect(result.current.reports.has(5)).toBe(true))
    expect(scouted).toEqual([5])
  })

  it('skips players already off the board', async () => {
    const picks = new Map<number, Pick>([
      [1, { playerId: 1, status: 'gone', price: 0, at: 0 }],
      [2, { playerId: 2, status: 'mine', price: 20, at: 0 }],
    ])
    const { adapter, scouted } = makeAdapter()
    const { result } = renderHook(() => useScout(adapter, BOARD, picks, 2))

    await waitFor(() => expect(result.current.reports.size).toBe(2))
    expect(scouted.sort()).toEqual([3, 4])
  })

  it('never runs more than two calls at once', async () => {
    let active = 0
    let peak = 0
    const { adapter } = makeAdapter({
      async scoutPlayer(p: Player) {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active -= 1
        return makeReport(p.id)
      },
    })

    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 5))
    await waitFor(() => expect(result.current.reports.size).toBe(5), { timeout: 2000 })

    // Rate limits and spend both argue against opening the floodgates.
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('does not scout the same player twice', async () => {
    const { adapter, scouted } = makeAdapter()
    const { result, rerender } = renderHook(
      ({ picks }) => useScout(adapter, BOARD, picks, 3),
      { initialProps: { picks: noPicks } },
    )
    await waitFor(() => expect(result.current.reports.size).toBe(3))

    // A pick lands; the top of the board shifts by one.
    rerender({ picks: new Map([[1, { playerId: 1, status: 'gone', price: 0, at: 0 }]]) })
    await waitFor(() => expect(result.current.reports.size).toBe(4))

    expect(scouted.sort()).toEqual([1, 2, 3, 4]) // 2 and 3 not repeated
  })

  it('records an error against the player and keeps going', async () => {
    const { adapter } = makeAdapter({
      async scoutPlayer(p: Player) {
        if (p.id === 1) throw new Error('Rate limited — try again in a moment')
        return makeReport(p.id)
      },
    })
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 3))

    await waitFor(() => expect(result.current.errors.get(1)).toMatch(/Rate limited/))
    expect(result.current.reports.has(2)).toBe(true)
  })

  it('stops the queue when the key itself is the problem', async () => {
    // One bad key would otherwise produce the same failure 10 times over.
    const scouted: number[] = []
    const { adapter } = makeAdapter({
      async scoutPlayer(p: Player): Promise<ScoutReport> {
        scouted.push(p.id)
        throw new ScoutError('API key rejected', 'auth')
      },
    })
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 5))

    await waitFor(() => expect(result.current.hasKey).toBe(false))
    await new Promise((r) => setTimeout(r, 30))
    expect(scouted.length).toBeLessThan(5)
  })

  it('counts calls so spend is visible', async () => {
    const { adapter } = makeAdapter()
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 3))
    await waitFor(() => expect(result.current.calls).toBe(3))
  })

  it('marks a player pending while its check is in flight', async () => {
    // Held open explicitly rather than with a timer, so the in-flight window
    // can't close before the assertion runs.
    let release!: () => void
    const inFlight = new Promise<void>((r) => (release = r))

    const { adapter } = makeAdapter({
      async scoutPlayer(p: Player) {
        await inFlight
        return makeReport(p.id)
      },
    })
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 1))

    await waitFor(() => expect(result.current.pending.has(1)).toBe(true))
    expect(result.current.reports.has(1)).toBe(false)

    await act(async () => {
      release()
      await inFlight
    })
    await waitFor(() => expect(result.current.reports.has(1)).toBe(true))

    // Regression: pending was added but never cleared, so the row showed a
    // loading pulse forever and the verdict chip never appeared.
    expect(result.current.pending.has(1)).toBe(false)
  })

  it('restores saved reports and does not pay for them again', async () => {
    const { adapter, scouted, store } = makeAdapter()
    store.saved = [report(1), report(2), report(3)]

    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 3))

    await waitFor(() => expect(result.current.reports.size).toBe(3))
    expect(scouted).toEqual([]) // the whole point: no re-spend on reload
  })

  it('persists each report as it lands', async () => {
    const { adapter, store } = makeAdapter()
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 2))

    await waitFor(() => expect(result.current.reports.size).toBe(2))
    await waitFor(() => expect(store.saved).toHaveLength(2))
    expect(store.saved.map((r) => r.playerId).sort()).toEqual([1, 2])
  })

  it('discards reports past the TTL rather than passing off stale news', async () => {
    const { adapter, scouted, store } = makeAdapter()
    store.saved = [report(1, REPORT_TTL_MS + 60_000), report(2)]

    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 2))

    // The stale one is dropped and re-checked; the fresh one is reused.
    await waitFor(() => expect(scouted).toEqual([1]))
    expect(result.current.reports.has(2)).toBe(true)
  })

  it('clears every report when the draft is reset', async () => {
    const { adapter, store } = makeAdapter()
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 2))
    await waitFor(() => expect(result.current.reports.size).toBe(2))

    act(() => result.current.clearReports())

    expect(result.current.reports.size).toBe(0)
    await waitFor(() => expect(store.saved).toEqual([]))
  })

  it('does not re-buy reports it already holds when the key is re-saved', async () => {
    // Regression: refreshKey used to wipe the "already scouted" set, so saving
    // a key after reports existed re-ran every one of them — real money.
    const { adapter, scouted, store } = makeAdapter()
    store.saved = [report(1), report(2), report(3)]
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 3))
    await waitFor(() => expect(result.current.reports.size).toBe(3))

    await act(async () => {
      await result.current.refreshKey()
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(scouted).toEqual([])
  })

  it('ignores a manual re-check for a player already in flight', async () => {
    // Regression: scoutNow dropped the player from the dedupe set and pushed it
    // onto the queue again, so a double-tap paid twice for one answer.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const attempts: number[] = []
    const { adapter } = makeAdapter({
      async scoutPlayer(p: Player) {
        attempts.push(p.id)
        await held
        return makeReport(p.id)
      },
    })
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 1))
    await waitFor(() => expect(result.current.pending.has(1)).toBe(true))

    act(() => result.current.scoutNow(BOARD[0]))
    act(() => result.current.scoutNow(BOARD[0]))

    await act(async () => {
      release()
      await held
    })
    await waitFor(() => expect(result.current.reports.has(1)).toBe(true))
    expect(attempts.filter((id) => id === 1)).toHaveLength(1)
  })

  it('lets a manual re-check refresh a report it already has', async () => {
    const { adapter, scouted, store } = makeAdapter()
    store.saved = [report(1)]
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 0))
    await waitFor(() => expect(result.current.reports.has(1)).toBe(true))
    expect(scouted).toEqual([])

    act(() => result.current.scoutNow(BOARD[0]))
    await waitFor(() => expect(scouted).toEqual([1]))
  })

  it('does not count a failed-auth attempt against spend', async () => {
    // It never reached the API, so charging it to the meter would mislead.
    const { adapter } = makeAdapter({
      async scoutPlayer(): Promise<ScoutReport> {
        throw new ScoutError('API key rejected', 'auth')
      },
    })
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 3))

    await waitFor(() => expect(result.current.errors.size).toBeGreaterThan(0))
    expect(result.current.calls).toBe(0)
  })

  it('clears pending even when the check fails', async () => {
    const { adapter } = makeAdapter({
      async scoutPlayer(): Promise<ScoutReport> {
        throw new Error('Could not reach Claude')
      },
    })
    const { result } = renderHook(() => useScout(adapter, BOARD, noPicks, 1))

    await waitFor(() => expect(result.current.errors.size).toBe(1))
    expect(result.current.pending.size).toBe(0)
  })
})
