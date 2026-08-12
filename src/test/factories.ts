import type { Player, ScoutReport, Verdict } from '../domain/types'

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
