import { describe, it, expect } from 'vitest'
import {
  TEAM_COUNT,
  headshotUrl,
  initials,
  isTeamEntity,
  teamAbbr,
  teamLogoUrl,
  teamName,
} from './proTeams'
import { coachPlayers } from './coaches'

describe('pro team map', () => {
  it('covers the league exactly once', () => {
    expect(TEAM_COUNT).toBe(32)
  })

  it('resolves the ids that are easy to get wrong', () => {
    // 31 and 32 are unused; Baltimore and Houston sit above the gap.
    expect(teamAbbr(33)).toBe('BAL')
    expect(teamAbbr(34)).toBe('HOU')
    expect(teamAbbr(31)).toBeNull()
    expect(teamAbbr(32)).toBeNull()
    // Not alphabetical: 10 is Tennessee, not Cleveland.
    expect(teamName(10)).toBe('Tennessee Titans')
  })

  it('treats free agents as having no team', () => {
    expect(teamAbbr(0)).toBeNull()
    expect(teamLogoUrl(0)).toBeNull()
  })

  // Two hand-transcribed 32-team tables now exist — this one and `coaches.ts`.
  // Nothing else makes them agree, so a relocation edited into one and not the
  // other would otherwise ship as a coach row with no crest.
  it('agrees with the coach roster on which teams exist', () => {
    const coachTeams = coachPlayers().map((c) => c.proTeamId)
    expect(coachTeams).toHaveLength(TEAM_COUNT)
    expect(new Set(coachTeams).size).toBe(TEAM_COUNT)
    expect(coachTeams.filter((id) => teamAbbr(id) === null)).toEqual([])
  })
})

describe('asset urls', () => {
  it('builds a headshot from the player id alone', () => {
    expect(headshotUrl(4429795)).toBe(
      'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/4429795.png&h=102',
    )
  })

  it('lowercases the abbreviation for the logo path', () => {
    expect(teamLogoUrl(28)).toBe(
      'https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/wsh.png&h=102',
    )
  })

  it('constrains one axis only, so nothing comes back stretched', () => {
    // ESPN's combiner does not crop to a box: given both `w` and `h` it scales
    // the axes independently, and a 600x436 headshot asked for a square comes
    // back with the face 1.35x too narrow. Height alone keeps the ratio and
    // lets `object-fit: cover` on the avatar do the cropping.
    for (const url of [headshotUrl(4429795)!, teamLogoUrl(28)!]) {
      const params = new URLSearchParams(new URL(url).search)
      expect(params.get('h')).toBe('102')
      expect(params.has('w')).toBe(false)
    }
  })

  it('has no headshot for D/ST or head coaches', () => {
    // ESPN's D/ST ids and our coach ids are both synthetic negatives — there is
    // no athlete record behind either, so asking would 404.
    expect(headshotUrl(-16034)).toBeNull()
    expect(headshotUrl(-14001)).toBeNull()
    expect(isTeamEntity(-16034)).toBe(true)
    expect(isTeamEntity(4429795)).toBe(false)
  })

})

describe('initials', () => {
  it('takes first and last', () => {
    expect(initials('Jahmyr Gibbs')).toBe('JG')
    expect(initials("Ja'Marr Chase")).toBe('JC')
  })

  it('survives one-word and empty names', () => {
    expect(initials('Texans')).toBe('T')
    expect(initials('  ')).toBe('?')
  })

  it('uses the last part, not the second', () => {
    expect(initials('Amon-Ra St. Brown')).toBe('AB')
  })
})
