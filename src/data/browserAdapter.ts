import type { CachedRankings, DataAdapter } from './adapter'
import { fetchRankings } from './espn'
import type { DraftState, Scoring } from '../domain/types'

const KEY_RANKINGS = 'fanman.rankings.v1'
const KEY_DRAFT = 'fanman.draft.v1'

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
