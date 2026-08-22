import type { CachedRankings, ChatRequest, DataAdapter } from './adapter'
import { fetchRankings } from './espn'
import type {
  ChatTurn,
  DraftState,
  Player,
  PlayerProfile,
  ScoutReport,
  Scoring,
} from '../domain/types'
import { fetchProfile } from './profile'
import { scoutPlayer } from './scout'
import { streamChat } from './chat'
import { ScoutError } from './scoutError'

const KEY_RANKINGS = 'fanman.rankings.v1'
const KEY_DRAFT = 'fanman.draft.v1'
const KEY_API = 'fanman.apiKey.v1'
const KEY_SCOUT = 'fanman.scout.v1'
const KEY_PROFILE = 'fanman.profile.v1'
const KEY_CHAT = 'fanman.chat.v1'

/** ~1KB each, so this is well under quota even alongside the rankings cache. */
const MAX_CACHED_PROFILES = 150

/**
 * Browser implementation. State lives in localStorage: the draft log is tiny,
 * and a 300-player ranking cache is well under the quota. Everything the app
 * needs during a draft is on the device, so a dead network costs us nothing but
 * freshness.
 */
export class BrowserAdapter implements DataAdapter {
  fetchRankings(scoring: Scoring) {
    return fetchRankings(scoring)
  }

  async loadRankings(): Promise<CachedRankings | null> {
    return read<CachedRankings>(KEY_RANKINGS)
  }

  async saveRankings(cached: CachedRankings): Promise<void> {
    write(KEY_RANKINGS, cached)
  }

  async loadDraft(): Promise<DraftState | null> {
    return read<DraftState>(KEY_DRAFT)
  }

  async saveDraft(state: DraftState): Promise<void> {
    write(KEY_DRAFT, state)
  }

  async loadApiKey(): Promise<string | null> {
    try {
      return localStorage.getItem(KEY_API) // stored raw, not JSON-wrapped
    } catch {
      return null
    }
  }

  async saveApiKey(key: string): Promise<void> {
    try {
      if (key) localStorage.setItem(KEY_API, key)
      else localStorage.removeItem(KEY_API)
    } catch (err) {
      console.error('fanman: failed to persist API key', err)
    }
  }

  async loadScoutReports(): Promise<ScoutReport[]> {
    return read<ScoutReport[]>(KEY_SCOUT) ?? []
  }

  async saveScoutReports(reports: ScoutReport[]): Promise<void> {
    write(KEY_SCOUT, reports)
  }

  fetchProfile(playerId: number): Promise<PlayerProfile> {
    return fetchProfile(playerId)
  }

  async loadProfiles(): Promise<PlayerProfile[]> {
    return read<PlayerProfile[]>(KEY_PROFILE) ?? []
  }

  async saveProfiles(profiles: PlayerProfile[]): Promise<void> {
    // Bounded so a long session can't grow the cache without limit. These are
    // free to refetch, so evicting the least recently fetched costs a request
    // and nothing else — unlike the scout cache, which we never trim.
    // The cap almost never binds — a draft opens a few dozen rows — and this
    // runs on the main thread just as the card is trying to paint, so the copy
    // and sort are only paid for when there is actually something to evict.
    const trimmed =
      profiles.length <= MAX_CACHED_PROFILES
        ? profiles
        : [...profiles].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, MAX_CACHED_PROFILES)
    write(KEY_PROFILE, trimmed)
  }

  async scoutPlayer(player: Player): Promise<ScoutReport> {
    const key = await this.loadApiKey()
    if (!key) throw new ScoutError('No API key set — add one in Settings', 'auth')
    return scoutPlayer(key, player)
  }

  /**
   * An async generator, which is an `AsyncIterable` — so the key can be read
   * before the first delta without the interface having to be a promise of an
   * iterable, which every caller would then have to await before looping.
   */
  async *chat(req: ChatRequest) {
    const key = await this.loadApiKey()
    if (!key) throw new ScoutError('No API key set — add one in Settings', 'auth')
    yield* streamChat(key, req)
  }

  async loadChat(): Promise<ChatTurn[]> {
    return read<ChatTurn[]>(KEY_CHAT) ?? []
  }

  async saveChat(turns: ChatTurn[]): Promise<void> {
    write(KEY_CHAT, turns)
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    // Corrupt or unreadable storage must not take the board down mid-draft.
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.error(`fanman: failed to persist ${key}`, err)
  }
}
