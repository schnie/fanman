/**
 * ESPN's fantasy `proTeamId` → the NFL team it means.
 *
 * Read out of `.../seasons/2026?view=proTeamSchedules_wl` rather than typed
 * from memory. The ids are not contiguous and not alphabetical: 31 and 32 are
 * unused, Baltimore and Houston sit at 33 and 34, and 0 is the free-agent
 * bucket — which is why this is a map rather than an array.
 */
const TEAMS: Record<number, { abbr: string; name: string }> = {
  1: { abbr: 'ATL', name: 'Atlanta Falcons' },
  2: { abbr: 'BUF', name: 'Buffalo Bills' },
  3: { abbr: 'CHI', name: 'Chicago Bears' },
  4: { abbr: 'CIN', name: 'Cincinnati Bengals' },
  5: { abbr: 'CLE', name: 'Cleveland Browns' },
  6: { abbr: 'DAL', name: 'Dallas Cowboys' },
  7: { abbr: 'DEN', name: 'Denver Broncos' },
  8: { abbr: 'DET', name: 'Detroit Lions' },
  9: { abbr: 'GB', name: 'Green Bay Packers' },
  10: { abbr: 'TEN', name: 'Tennessee Titans' },
  11: { abbr: 'IND', name: 'Indianapolis Colts' },
  12: { abbr: 'KC', name: 'Kansas City Chiefs' },
  13: { abbr: 'LV', name: 'Las Vegas Raiders' },
  14: { abbr: 'LAR', name: 'Los Angeles Rams' },
  15: { abbr: 'MIA', name: 'Miami Dolphins' },
  16: { abbr: 'MIN', name: 'Minnesota Vikings' },
  17: { abbr: 'NE', name: 'New England Patriots' },
  18: { abbr: 'NO', name: 'New Orleans Saints' },
  19: { abbr: 'NYG', name: 'New York Giants' },
  20: { abbr: 'NYJ', name: 'New York Jets' },
  21: { abbr: 'PHI', name: 'Philadelphia Eagles' },
  22: { abbr: 'ARI', name: 'Arizona Cardinals' },
  23: { abbr: 'PIT', name: 'Pittsburgh Steelers' },
  24: { abbr: 'LAC', name: 'Los Angeles Chargers' },
  25: { abbr: 'SF', name: 'San Francisco 49ers' },
  26: { abbr: 'SEA', name: 'Seattle Seahawks' },
  27: { abbr: 'TB', name: 'Tampa Bay Buccaneers' },
  28: { abbr: 'WSH', name: 'Washington Commanders' },
  29: { abbr: 'CAR', name: 'Carolina Panthers' },
  30: { abbr: 'JAX', name: 'Jacksonville Jaguars' },
  33: { abbr: 'BAL', name: 'Baltimore Ravens' },
  34: { abbr: 'HOU', name: 'Houston Texans' },
}

/**
 * Exported for the tests rather than for callers: a dropped or duplicated key
 * in a hand-transcribed 32-entry map is otherwise invisible until a crest goes
 * missing mid-draft.
 */
export const TEAM_COUNT = Object.keys(TEAMS).length

/** `null` for free agents (id 0) and anything ESPN adds that we don't know. */
export function teamAbbr(proTeamId: number): string | null {
  return TEAMS[proTeamId]?.abbr ?? null
}

export function teamName(proTeamId: number): string | null {
  return TEAMS[proTeamId]?.name ?? null
}

/**
 * Both of these are pure string building — no request, no key, no failure
 * mode. Every player on the board already carries the id each one needs, so
 * the whole identity layer costs nothing beyond the image itself.
 */
export function teamLogoUrl(proTeamId: number): string | null {
  const abbr = teamAbbr(proTeamId)
  return abbr ? `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png` : null
}

/**
 * ESPN's headshot CDN is keyed by the same athlete id the fantasy rankings
 * hand us, so no lookup stands between a player and their photo.
 *
 * Team entities — D/ST and head coaches — are given synthetic negative ids by
 * ESPN (and by `coaches.ts`), have no athlete record, and 404 here. They get
 * the team logo instead, which is the right picture for them anyway.
 */
export function headshotUrl(playerId: number): string | null {
  return playerId > 0 ? `https://a.espncdn.com/i/headshots/nfl/players/full/${playerId}.png` : null
}

/** True when ESPN has no athlete record behind this id — D/ST and coaches. */
export function isTeamEntity(playerId: number): boolean {
  return playerId < 0
}

/** Fallback for a player whose headshot ESPN never published. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0]
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}
