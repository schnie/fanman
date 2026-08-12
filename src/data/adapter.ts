import type { DraftState, Player, ScoutReport, Scoring } from '../domain/types'

export interface CachedRankings {
  players: Player[]
  scoring: Scoring
  fetchedAt: number
}

/**
 * Every escape from the UI into the outside world goes through here. The board,
 * the budget math and the settings screen are written against this interface
 * only, which is what lets the same frontend ship as a PWA or inside a Wails
 * binary without changes.
 */
export interface DataAdapter {
  /** Live pull. Throws if the network or ESPN is unavailable — callers fall back to cache. */
  fetchRankings(scoring: Scoring): Promise<Player[]>

  loadRankings(): Promise<CachedRankings | null>
  saveRankings(cached: CachedRankings): Promise<void>

  loadDraft(): Promise<DraftState | null>
  saveDraft(state: DraftState): Promise<void>

  /** Phase 2. Present so the UI can render a scout panel before it exists. */
  scoutPlayer?(player: Player): Promise<ScoutReport>
}
