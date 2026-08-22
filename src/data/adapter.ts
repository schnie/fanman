import type { ChatDelta, ChatRequest } from './chat'
import type {
  ChatTurn,
  DraftState,
  Player,
  PlayerProfile,
  ScoutReport,
  Scoring,
} from '../domain/types'

export type { ChatDelta, ChatRequest }

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

  /**
   * One answer, streamed.
   *
   * The only method here that isn't a `Promise`, and it has to be: a chat that
   * arrives in one lump after twenty seconds is unusable on draft day, where
   * the value of an answer decays by the second. An async iterable rather than
   * a callback so a fake adapter can be an async generator yielding scripted
   * deltas — which is what keeps `App.dom.test.tsx` driving the real chat UI
   * with no network.
   *
   * Rejects with a `ScoutError`, same taxonomy as `scoutPlayer`: same client,
   * same account, same things that go wrong.
   */
  chat(req: ChatRequest): AsyncIterable<ChatDelta>

  /**
   * The transcript survives a refresh, for the same reason scout reports do:
   * every turn in it was paid for, and losing the thread mid-draft to a stray
   * reload is the expensive failure. Cleared with the draft.
   */
  loadChat(): Promise<ChatTurn[]>
  saveChat(turns: ChatTurn[]): Promise<void>
}
