import { POSITIONS, type Player, type Scoring } from '../domain/types'
import { coachPlayers } from './coaches'
import { fetchByeWeeks, type ByeWeeks } from './byes'
import { fetchTeamStrength } from './fpi'

export const SEASON = 2026

const ENDPOINT =
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leaguedefaults/3?view=kona_player_info`

/**
 * ESPN reflects any Origin and allows `x-fantasy-filter` on preflight, so this
 * runs straight from the browser with no proxy in between.
 */
export async function fetchRankings(scoring: Scoring, limit = 300): Promise<Player[]> {
  const filter = {
    players: {
      limit,
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: scoring },
    },
  }

  // Rankings are load-bearing; FPI only decorates the coaches and the byes only
  // decorate everyone. Run all three at once but let the two decorations fail on
  // their own — neither a power-index nor a schedule outage may cost us the board.
  const [rankings, strength, byes] = await Promise.all([
    fetch(ENDPOINT, {
      headers: { accept: 'application/json', 'x-fantasy-filter': JSON.stringify(filter) },
    }),
    fetchTeamStrength(SEASON).catch(() => undefined),
    fetchByeWeeks(SEASON).catch(() => undefined),
  ])

  if (!rankings.ok) throw new Error(`ESPN responded ${rankings.status}`)

  const body = await rankings.json()
  // Coaches are in no league-default profile, so they're appended rather than
  // fetched. Unranked, they sit below the priced board.
  return [...normalize(body?.players ?? [], scoring, byes), ...coachPlayers(strength, byes)]
}

/**
 * ESPN's payload is wide and inconsistently populated — deep-drafted players
 * routinely have no ownership block and no rank. Missing numerics become 0 so
 * the board can sort without special-casing every field.
 */
export function normalize(raw: unknown[], scoring: Scoring, byes?: ByeWeeks): Player[] {
  const players: Player[] = []

  for (const entry of raw as any[]) {
    const p = entry?.player
    if (!p) continue

    const ranks = p.draftRanksByRankType?.[scoring]
    const own = p.ownership

    players.push({
      id: p.id,
      name: p.fullName ?? 'Unknown',
      position: POSITIONS[p.defaultPositionId] ?? '—',
      proTeamId: p.proTeamId ?? 0,
      rank: ranks?.rank ?? 0,
      espnValue: ranks?.auctionValue ?? 0,
      marketValue: round1(own?.auctionValueAverage ?? 0),
      // Kept raw. It is a small daily delta compared against a domain
      // threshold, so rounding here (to 0.1) collapsed the useful range and
      // broke that comparison. Display rounds it instead.
      marketChange: own?.auctionValueAverageChange ?? 0,
      adp: round1(own?.averageDraftPosition ?? 0),
      percentOwned: round1(own?.percentOwned ?? 0),
      injuryStatus: p.injuryStatus ?? null,
      injured: Boolean(p.injured),
      projectedPoints: round1(p.ratings?.['0']?.totalRating ?? 0),
      // Left undefined when the schedule call failed or the team is unknown:
      // "we don't know this player's bye" and "this player has no bye" must
      // not collapse into the same rendering.
      byeWeek: byes?.get(p.proTeamId ?? 0),
    })
  }

  // Unranked players sort to the bottom rather than to the top.
  return players.sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity))
}

function round1(n: number): number {
  const r = Math.round(n * 10) / 10
  // Small negative drift (-0.01) rounds to -0, which renders as "-0". Collapse
  // it to a plain zero. `-0 === 0` is true, so this comparison catches both.
  return r === 0 ? 0 : r
}
