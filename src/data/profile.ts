import type { PlayerProfile, StatLine } from '../domain/types'
import { isTeamEntity } from './proTeams'

const BASE = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes'

/**
 * Two public ESPN endpoints, keyed by the same athlete id the fantasy rankings
 * already give us. Both send `access-control-allow-origin: *`, so — like the
 * rankings pull — this runs straight from the browser with no proxy and no key.
 *
 *   `/athletes/{id}`           bio, team, college, draft, last season's stats
 *   `/athletes/{id}/overview`  Rotowire's dated note
 *
 * Roughly 11KB and 24KB gzipped. Fetched lazily when a row is opened rather
 * than for the whole board, which would be ~35KB × 230.
 */
export async function fetchProfile(playerId: number): Promise<PlayerProfile> {
  if (isTeamEntity(playerId)) {
    throw new Error('ESPN publishes no athlete profile for D/ST or head coaches')
  }

  // The bio is the profile; the blurb decorates it. Settled separately so a
  // missing or slow `overview` costs us the note and not the whole card.
  const [bio, overview] = await Promise.allSettled([
    getJson(`${BASE}/${playerId}`),
    getJson(`${BASE}/${playerId}/overview`),
  ])

  if (bio.status === 'rejected') throw bio.reason
  return normalizeProfile(
    playerId,
    bio.value,
    overview.status === 'fulfilled' ? overview.value : null,
  )
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`ESPN responded ${res.status}`)
  return res.json()
}

/**
 * Exported for tests, and because every field here is optional in practice —
 * ESPN populates the bio unevenly and drops whole blocks for players who
 * haven't played. Anything missing becomes `null` so the card can omit a line
 * rather than render "undefined".
 */
export function normalizeProfile(
  playerId: number,
  bio: unknown,
  overview: unknown,
  now = Date.now(),
): PlayerProfile {
  const a = (bio as any)?.athlete ?? {}
  const summary = a.statsSummary ?? {}
  const rotowire = (overview as any)?.rotowire

  return {
    playerId,
    team: str(a.team?.displayName),
    jersey: str(a.displayJersey),
    height: str(a.displayHeight),
    weight: str(a.displayWeight),
    age: typeof a.age === 'number' ? a.age : null,
    birthPlace: str(a.displayBirthPlace),
    college: str(a.college?.name),
    draft: str(a.displayDraft),
    experience: str(a.displayExperience),
    status: str(a.status?.name),
    statsLabel: str(summary.displayName),
    stats: normalizeStats(summary.statistics),
    // A blurb with no headline is not a blurb. `story` is allowed to be empty:
    // the headline alone is often the whole item.
    blurb: str(rotowire?.headline)
      ? {
          headline: rotowire.headline,
          story: str(rotowire.story) ?? '',
          published: str(rotowire.published) ?? '',
        }
      : null,
    fetchedAt: now,
  }
}

function normalizeStats(raw: unknown): StatLine[] {
  if (!Array.isArray(raw)) return []
  const lines: StatLine[] = []
  for (const s of raw as any[]) {
    const label = str(s?.shortDisplayName) ?? str(s?.displayName)
    const value = str(s?.displayValue)
    if (!label || !value) continue
    lines.push({ label, value, rank: str(s?.rankDisplayValue) })
  }
  return lines
}

/** Empty strings are as absent as missing keys here, and read worse. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
