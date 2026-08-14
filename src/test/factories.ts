import type { Player, PlayerProfile, ScoutReport, Verdict } from '../domain/types'

/** One `Player` fixture for every suite — four hand-written copies had drifted. */
export function makePlayer(over: Partial<Player> = {}): Player {
  return {
    id: 1,
    name: 'Test Player',
    position: 'RB',
    proTeamId: 1,
    rank: 1,
    espnValue: 50,
    marketValue: 55,
    marketChange: 0,
    adp: 1,
    percentOwned: 90,
    injuryStatus: null,
    injured: false,
    projectedPoints: 200,
    ...over,
  }
}

/**
 * Deliberately sparse where ESPN is sparse: every field but the id is optional
 * in the wild, so the default fixture keeps the ones the card actually leads
 * with and leaves the rest for callers to fill in.
 */
export function makeProfile(
  playerId: number,
  over: Partial<PlayerProfile> = {},
): PlayerProfile {
  return {
    playerId,
    team: 'Detroit Lions',
    jersey: '#0',
    height: '5\' 9"',
    weight: '202 lbs',
    age: 24,
    birthPlace: 'Dalton, GA',
    college: 'Alabama',
    draft: '2023: Rd 1, Pk 12 (DET)',
    experience: '4th Season',
    status: 'Active',
    statsLabel: '2025 regular season stats',
    stats: [{ label: 'Rush Yards', value: '1,223', rank: '7th' }],
    blurb: null,
    fetchedAt: Date.now(),
    ...over,
  }
}

export function makeReport(
  playerId: number,
  over: Partial<ScoutReport> & { verdict?: Verdict } = {},
): ScoutReport {
  return {
    playerId,
    verdict: 'GREEN',
    headline: 'Nothing new.',
    notes: [],
    sources: [],
    fetchedAt: Date.now(),
    ...over,
  }
}
