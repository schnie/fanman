import type { Player, TeamStrength } from '../domain/types'
import { derivedCoachValues } from './fpi'

/**
 * Head coaches as roster entities, one per NFL team.
 *
 * These are baked in rather than fetched, deliberately. ESPN only exposes them
 * through the full player-universe view (~2.3MB, all 11.5k players) and carries
 * **no rank, auction value, ADP or ownership** for them under any league-default
 * profile — so there is nothing to keep fresh, and nothing to justify that
 * download on cell service mid-draft.
 *
 * Regenerate if a franchise renames:
 *   curl -s 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<year>/players?view=players_wl' \
 *     -H 'x-fantasy-filter: {"players":{}}' \
 *     | jq -r '.[] | select(.defaultPositionId==14) | "\(.id) \(.fullName) \(.proTeamId)"'
 *
 * (proTeamId skips 31/32 — Ravens and Texans are 33 and 34.)
 */
const COACHES: { id: number; name: string; proTeamId: number }[] = [
  { id: -14001, name: 'Falcons Coach', proTeamId: 1 },
  { id: -14002, name: 'Bills Coach', proTeamId: 2 },
  { id: -14003, name: 'Bears Coach', proTeamId: 3 },
  { id: -14004, name: 'Bengals Coach', proTeamId: 4 },
  { id: -14005, name: 'Browns Coach', proTeamId: 5 },
  { id: -14006, name: 'Cowboys Coach', proTeamId: 6 },
  { id: -14007, name: 'Broncos Coach', proTeamId: 7 },
  { id: -14008, name: 'Lions Coach', proTeamId: 8 },
  { id: -14009, name: 'Packers Coach', proTeamId: 9 },
  { id: -14010, name: 'Titans Coach', proTeamId: 10 },
  { id: -14011, name: 'Colts Coach', proTeamId: 11 },
  { id: -14012, name: 'Chiefs Coach', proTeamId: 12 },
  { id: -14013, name: 'Raiders Coach', proTeamId: 13 },
  { id: -14014, name: 'Rams Coach', proTeamId: 14 },
  { id: -14015, name: 'Dolphins Coach', proTeamId: 15 },
  { id: -14016, name: 'Vikings Coach', proTeamId: 16 },
  { id: -14017, name: 'Patriots Coach', proTeamId: 17 },
  { id: -14018, name: 'Saints Coach', proTeamId: 18 },
  { id: -14019, name: 'Giants Coach', proTeamId: 19 },
  { id: -14020, name: 'Jets Coach', proTeamId: 20 },
  { id: -14021, name: 'Eagles Coach', proTeamId: 21 },
  { id: -14022, name: 'Cardinals Coach', proTeamId: 22 },
  { id: -14023, name: 'Steelers Coach', proTeamId: 23 },
  { id: -14024, name: 'Chargers Coach', proTeamId: 24 },
  { id: -14025, name: '49ers Coach', proTeamId: 25 },
  { id: -14026, name: 'Seahawks Coach', proTeamId: 26 },
  { id: -14027, name: 'Buccaneers Coach', proTeamId: 27 },
  { id: -14028, name: 'Commanders Coach', proTeamId: 28 },
  { id: -14029, name: 'Panthers Coach', proTeamId: 29 },
  { id: -14030, name: 'Jaguars Coach', proTeamId: 30 },
  { id: -14033, name: 'Ravens Coach', proTeamId: 33 },
  { id: -14034, name: 'Texans Coach', proTeamId: 34 },
]

/**
 * Coaches as `Player`s.
 *
 * ESPN's own value fields stay at zero — we never fabricate those. When team
 * strength is supplied, each coach instead gets a `derivedValue` plus the
 * projected wins and FPI rank it came from, and the list is ordered strongest
 * team first. Without it they're returned unvalued in team order, which is the
 * graceful-degradation path when FPI is unreachable.
 */
export function coachPlayers(strength?: Map<number, TeamStrength>): Player[] {
  const values = strength ? derivedCoachValues(strength) : new Map<number, number>()

  const players: Player[] = COACHES.map((c) => {
    const team = strength?.get(c.proTeamId)
    return {
      id: c.id,
      name: c.name,
      position: 'HC',
      proTeamId: c.proTeamId,
      rank: 0,
      espnValue: 0,
      marketValue: 0,
      marketChange: 0,
      adp: 0,
      percentOwned: 0,
      injuryStatus: null,
      injured: false,
      projectedPoints: 0,
      derivedValue: values.get(c.proTeamId),
      projectedWins: team?.projectedWins,
      fpiRank: team?.fpiRank,
    }
  })

  // Best team first. Coaches all share rank 0, so without this they'd sit in
  // arbitrary franchise-id order on the board.
  return players.sort((a, b) => (b.projectedWins ?? 0) - (a.projectedWins ?? 0))
}
