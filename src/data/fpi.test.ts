import { describe, it, expect } from 'vitest'
import { parseFpi, derivedCoachValues, HC_VALUE_CEILING } from './fpi'
import type { TeamStrength } from '../domain/types'

/**
 * Mirrors the real payload's awkward shape: labels live once at the top level,
 * each team carries a bare positional `values` array, and that array is SHORTER
 * than the label list.
 */
const body = {
  categories: [
    {
      name: 'fpi',
      names: ['fpi', 'epaoffense', 'epadefense', 'epaspecialteams', 'fpirank', 'accomplishmentrank',
        'avgsosrank', 'sosremainingrank', 'gamecontrolrank', 'avgingamewprank', 'rankchange7days',
        'numwins', 'numlosses', 'numties'],
    },
    {
      name: 'projections',
      names: ['projectedw', 'projectedl', 'probwinout', 'probwinconf', 'probwindiv',
        'probmakeplayoffs', 'probmakedivplayoffs', 'probmaketitlegame', 'probwintitle',
        'probmakeconfchamp'],
    },
  ],
  teams: [
    {
      team: { id: '14', name: 'Rams' },
      categories: [
        { name: 'fpi', values: [5.574, 3.947, 1.511, 0.116, 1.0, 0.0] },
        { name: 'projections', values: [11.09, 5.857, 0.0, null, 46.0, 81.8] },
      ],
    },
    {
      team: { id: '15', name: 'Dolphins' },
      categories: [
        { name: 'fpi', values: [-5.805, -2.1, -3.0, -0.2, 32.0, 0.0] },
        { name: 'projections', values: [4.832, 12.1, 0.0, null, 3.0, 4.2] },
      ],
    },
  ],
}

describe('parseFpi', () => {
  it('pulls projected wins, FPI and rank keyed by proTeamId', () => {
    const out = parseFpi(body)
    expect(out.get(14)).toEqual({
      proTeamId: 14,
      projectedWins: 11.09,
      fpi: 5.574,
      fpiRank: 1,
    })
    expect(out.get(15)?.fpiRank).toBe(32)
  })

  it('does not read past the end of a short values array', () => {
    // `numwins` is index 11 but only 6 values exist — must not be misread.
    const out = parseFpi(body)
    expect(out.get(14)?.projectedWins).toBe(11.09)
    expect(out.size).toBe(2)
  })

  it('skips a team with no projection rather than inventing one', () => {
    const partial = {
      ...body,
      teams: [{ team: { id: '99' }, categories: [{ name: 'fpi', values: [1] }] }],
    }
    expect(parseFpi(partial).size).toBe(0)
  })

  it('tolerates a malformed or empty payload', () => {
    expect(parseFpi(null).size).toBe(0)
    expect(parseFpi({}).size).toBe(0)
    expect(parseFpi({ teams: [{}] }).size).toBe(0)
  })

  it('ignores nulls inside the values array', () => {
    // `probwinconf` is null upstream; it must not become 0.
    const out = parseFpi(body)
    expect(out.get(14)?.fpi).toBe(5.574)
  })
})

const strength = (proTeamId: number, projectedWins: number): TeamStrength => ({
  proTeamId,
  projectedWins,
  fpi: 0,
  fpiRank: 0,
})

describe('derivedCoachValues', () => {
  it('spans $1 to the ceiling between weakest and strongest team', () => {
    const values = derivedCoachValues(
      new Map([
        [1, strength(1, 11.09)],
        [2, strength(2, 8)],
        [3, strength(3, 4.832)],
      ]),
    )
    expect(values.get(1)).toBe(HC_VALUE_CEILING)
    expect(values.get(3)).toBe(1)
    expect(values.get(2)).toBeGreaterThan(1)
    expect(values.get(2)).toBeLessThan(HC_VALUE_CEILING)
  })

  it('never goes below $1', () => {
    const values = derivedCoachValues(new Map([[1, strength(1, 0)], [2, strength(2, 17)]]))
    expect(Math.min(...values.values())).toBe(1)
  })

  it('does not divide by zero when every team projects the same', () => {
    const values = derivedCoachValues(new Map([[1, strength(1, 9)], [2, strength(2, 9)]]))
    expect([...values.values()]).toEqual([1, 1])
  })

  it('returns nothing for an empty league', () => {
    expect(derivedCoachValues(new Map()).size).toBe(0)
  })
})
