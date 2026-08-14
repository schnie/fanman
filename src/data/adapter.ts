import type { DraftState, Player, PlayerProfile, ScoutReport, Scoring } from '../domain/types'

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

  /**
   * Stored apart from the draft so resetting a draft can't destroy it, and so
   * a Wails shell can keep it in a config file instead of web storage.
   */
  loadApiKey(): Promise<string | null>
  saveApiKey(key: string): Promise<void>

  /** Live news check. Rejects with a `ScoutError` when it can't answer. */
  scoutPlayer(player: Player): Promise<ScoutReport>

  /** Free, deterministic ESPN bio + stat line + Rotowire note. Throws for team entities. */
  fetchProfile(playerId: number): Promise<PlayerProfile>

  /**
   * Cached separately from scout reports: these cost nothing to refetch, so
   * they are a latency cache rather than something we must not lose.
   */
  loadProfiles(): Promise<PlayerProfile[]>
  saveProfiles(profiles: PlayerProfile[]): Promise<void>

  /**
   * Scout reports survive a refresh. Each one costs money and ~20s, so losing
   * an hour of them to an accidental reload is the worst waste in the app.
   */
  loadScoutReports(): Promise<ScoutReport[]>
  saveScoutReports(reports: ScoutReport[]): Promise<void>
}
