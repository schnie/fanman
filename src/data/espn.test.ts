import { describe, it, expect } from 'vitest'
import { normalize } from './espn'

/** Shapes taken from real 2026 `kona_player_info` responses. */
const GIBBS = {
  player: {
    id: 4429795,
    fullName: 'Jahmyr Gibbs',
    defaultPositionId: 2,
    proTeamId: 8,
    injuryStatus: 'ACTIVE',
    injured: false,
    draftRanksByRankType: {
      STANDARD: { rank: 1, auctionValue: 57 },
      PPR: { rank: 1, auctionValue: 57 },
    },
    ownership: {
      auctionValueAverage: 63.87,
      auctionValueAverageChange: -0.01,
      averageDraftPosition: 1.61,
      percentOwned: 99.87,
    },
    ratings: { '0': { totalRating: 366.90002 } },
  },
}

/** Deep-bench players come back with no ownership block and no ranks at all. */
const BARE = {
  player: {
    id: 15755,
    fullName: 'Fozzy Whittaker',
    defaultPositionId: 2,
    proTeamId: 0,
  },
}

describe('normalize', () => {
  it('maps the fields the board renders', () => {
    const [p] = normalize([GIBBS], 'PPR')
    expect(p).toMatchObject({
      id: 4429795,
      name: 'Jahmyr Gibbs',
      position: 'RB',
      rank: 1,
      espnValue: 57,
      marketValue: 63.9,
      marketChange: 0,
      adp: 1.6,
      injured: false,
      projectedPoints: 366.9,
    })
  })

  it('reads the ranking set matching the selected scoring type', () => {
    const ppr = { ...GIBBS, player: { ...GIBBS.player, draftRanksByRankType: {
      STANDARD: { rank: 9, auctionValue: 30 },
      PPR: { rank: 1, auctionValue: 57 },
    } } }
    expect(normalize([ppr], 'PPR')[0].espnValue).toBe(57)
    expect(normalize([ppr], 'STANDARD')[0].espnValue).toBe(30)
    expect(normalize([ppr], 'STANDARD')[0].rank).toBe(9)
  })

  it('survives players with no ownership, ranks or ratings', () => {
    const [p] = normalize([BARE], 'PPR')
    expect(p.name).toBe('Fozzy Whittaker')
    expect(p.espnValue).toBe(0)
    expect(p.marketValue).toBe(0)
    expect(p.projectedPoints).toBe(0)
  })

  it('skips entries with no player payload instead of throwing', () => {
    expect(normalize([{}, null, GIBBS], 'PPR')).toHaveLength(1)
  })

  it('sorts by rank and pushes unranked players to the bottom', () => {
    const ranked = (id: number, rank: number) => ({
      player: { ...GIBBS.player, id, draftRanksByRankType: { PPR: { rank, auctionValue: 1 } } },
    })
    const out = normalize([BARE, ranked(2, 5), ranked(3, 1)], 'PPR')
    expect(out.map((p) => p.rank)).toEqual([1, 5, 0])
  })

  it('maps the head coach position id', () => {
    const coach = { player: { ...GIBBS.player, defaultPositionId: 14, fullName: 'Chiefs Coach' } }
    expect(normalize([coach], 'PPR')[0].position).toBe('HC')
  })

  it('maps every position id we display', () => {
    const at = (positionId: number) => ({
      player: { ...GIBBS.player, defaultPositionId: positionId },
    })
    const ids = [1, 2, 3, 4, 5, 14, 16]
    expect(normalize(ids.map(at), 'PPR').map((p) => p.position))
      .toEqual(['QB', 'RB', 'WR', 'TE', 'K', 'HC', 'D/ST'])
  })
})
