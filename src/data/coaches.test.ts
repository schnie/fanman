import { describe, it, expect } from 'vitest'
import { coachPlayers } from './coaches'
import { isUnpriced } from '../domain/types'

describe('coachPlayers', () => {
  const coaches = coachPlayers()

  it('supplies exactly one coach per NFL team', () => {
    expect(coaches).toHaveLength(32)
    expect(new Set(coaches.map((c) => c.id)).size).toBe(32)
    expect(new Set(coaches.map((c) => c.proTeamId)).size).toBe(32)
  })

  it('marks them all as HC', () => {
    expect(coaches.every((c) => c.position === 'HC')).toBe(true)
  })

  it('uses ESPN ids that cannot collide with real players', () => {
    // Real player ids are positive; team entities are negative.
    expect(coaches.every((c) => c.id < 0)).toBe(true)
  })

  it('reports as unpriced rather than as worth $0', () => {
    expect(coaches.every(isUnpriced)).toBe(true)
  })

  it('sorts below every ranked player', () => {
    expect(coaches.every((c) => c.rank === 0)).toBe(true)
  })

  it('orders coaches by projected wins when team strength is available', () => {
    const strength = new Map([
      [12, { proTeamId: 12, projectedWins: 11.5, fpi: 6, fpiRank: 1 }], // Chiefs
      [15, { proTeamId: 15, projectedWins: 4.5, fpi: -6, fpiRank: 32 }], // Dolphins
    ])
    const valued = coachPlayers(strength)

    expect(valued[0].name).toBe('Chiefs Coach')
    expect(valued[0].derivedValue).toBeGreaterThan(valued[1].derivedValue ?? 0)
    expect(valued[0].projectedWins).toBe(11.5)
    expect(valued[0].fpiRank).toBe(1)
    // Teams with no FPI entry sink below the ones that have projections.
    expect(valued.at(-1)?.projectedWins).toBeUndefined()
  })

  it('never writes an estimate into ESPN\'s own value fields', () => {
    const strength = new Map([
      [12, { proTeamId: 12, projectedWins: 11.5, fpi: 6, fpiRank: 1 }],
    ])
    const chiefs = coachPlayers(strength).find((c) => c.proTeamId === 12)!

    expect(chiefs.derivedValue).toBeGreaterThan(0)
    // The estimate must stay quarantined — these are ESPN's fields.
    expect(chiefs.espnValue).toBe(0)
    expect(chiefs.marketValue).toBe(0)
    expect(isUnpriced(chiefs)).toBe(true)
  })

  it('still returns all 32 coaches when FPI is unavailable', () => {
    const bare = coachPlayers(undefined)
    expect(bare).toHaveLength(32)
    expect(bare.every((c) => c.derivedValue === undefined)).toBe(true)
  })

  it('covers the teams ESPN numbers oddly', () => {
    // proTeamId skips 31/32 — Ravens and Texans are 33 and 34.
    const byTeam = new Map(coaches.map((c) => [c.proTeamId, c.name]))
    expect(byTeam.get(33)).toBe('Ravens Coach')
    expect(byTeam.get(34)).toBe('Texans Coach')
    expect(byTeam.has(31)).toBe(false)
    expect(byTeam.has(32)).toBe(false)
  })
})
