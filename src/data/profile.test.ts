import { describe, it, expect } from 'vitest'
import { fetchProfile, normalizeProfile } from './profile'

/** Trimmed from a real 2026 `/athletes/4429795` response. */
const BIO = {
  athlete: {
    id: '4429795',
    displayName: 'Jahmyr Gibbs',
    displayJersey: '#0',
    displayHeight: '5\' 9"',
    displayWeight: '202 lbs',
    age: 24,
    displayBirthPlace: 'Dalton, GA',
    displayExperience: '4th Season',
    displayDraft: '2023: Rd 1, Pk 12 (DET)',
    college: { id: '333', name: 'Alabama' },
    team: { id: '8', displayName: 'Detroit Lions', abbreviation: 'DET' },
    status: { id: '1', name: 'Active', type: 'active' },
    statsSummary: {
      displayName: '2025 regular season stats',
      statistics: [
        { shortDisplayName: 'Rush Yards', displayValue: '1,223', rankDisplayValue: '7th' },
        { shortDisplayName: 'Rushing Touchdowns', displayValue: '13', rankDisplayValue: 'Tied-4th' },
      ],
    },
  },
}

const OVERVIEW = {
  rotowire: {
    headline: 'The Lions and Gibbs agreed to terms on a three-year extension Thursday.',
    story: 'The $67.5 million deal includes $51.5 million guaranteed.',
    published: 'Thu Aug 06 14:32:15 PDT 2026',
  },
}

describe('normalizeProfile', () => {
  it('maps the fields the card renders', () => {
    const p = normalizeProfile(4429795, BIO, OVERVIEW, 1000)
    expect(p).toMatchObject({
      playerId: 4429795,
      team: 'Detroit Lions',
      jersey: '#0',
      height: '5\' 9"',
      weight: '202 lbs',
      age: 24,
      college: 'Alabama',
      draft: '2023: Rd 1, Pk 12 (DET)',
      experience: '4th Season',
      status: 'Active',
      statsLabel: '2025 regular season stats',
      fetchedAt: 1000,
    })
  })

  it('keeps the league rank with each stat', () => {
    const { stats } = normalizeProfile(1, BIO, OVERVIEW)
    expect(stats).toEqual([
      { label: 'Rush Yards', value: '1,223', rank: '7th' },
      { label: 'Rushing Touchdowns', value: '13', rank: 'Tied-4th' },
    ])
  })

  it('carries the blurb with its publish date', () => {
    const { blurb } = normalizeProfile(1, BIO, OVERVIEW)
    expect(blurb?.headline).toContain('three-year extension')
    expect(blurb?.published).toBe('Thu Aug 06 14:32:15 PDT 2026')
  })

  // The two requests are settled independently, so this is the shape we get
  // whenever `overview` is slow, rate-limited or simply has nothing.
  it('still produces a profile when the blurb is missing', () => {
    const p = normalizeProfile(1, BIO, null)
    expect(p.blurb).toBeNull()
    expect(p.team).toBe('Detroit Lions')
    expect(p.stats).toHaveLength(2)
  })

  it('drops a blurb that has no headline', () => {
    expect(normalizeProfile(1, BIO, { rotowire: { story: 'orphaned' } }).blurb).toBeNull()
  })

  it('allows a headline with no story', () => {
    const { blurb } = normalizeProfile(1, BIO, { rotowire: { headline: 'Signed.' } })
    expect(blurb).toEqual({ headline: 'Signed.', story: '', published: '' })
  })

  // ESPN populates the bio unevenly — players who never took a snap arrive with
  // whole blocks absent. Every line has to be individually omittable.
  it('nulls out everything absent rather than inventing it', () => {
    const p = normalizeProfile(99, { athlete: { displayName: 'Nobody' } }, null)
    expect(p).toMatchObject({
      playerId: 99,
      team: null,
      college: null,
      age: null,
      draft: null,
      status: null,
      statsLabel: null,
      blurb: null,
    })
    expect(p.stats).toEqual([])
  })

  it('treats empty strings as absent', () => {
    const p = normalizeProfile(1, { athlete: { displayHeight: '', college: { name: '   ' } } }, null)
    expect(p.height).toBeNull()
    expect(p.college).toBeNull()
  })

  it('skips stat entries with no label or no value', () => {
    const bio = {
      athlete: {
        statsSummary: {
          statistics: [
            { displayValue: '10' },
            { shortDisplayName: 'Targets' },
            { shortDisplayName: 'Receptions', displayValue: '61' },
          ],
        },
      },
    }
    expect(normalizeProfile(1, bio, null).stats).toEqual([
      { label: 'Receptions', value: '61', rank: null },
    ])
  })

  it('survives a payload with no athlete at all', () => {
    expect(normalizeProfile(1, {}, null).team).toBeNull()
    expect(normalizeProfile(1, null, null).team).toBeNull()
  })
})

describe('fetchProfile', () => {
  it('refuses team entities without a request', async () => {
    // Both D/ST and head coaches 404 on every athlete endpoint. Failing here
    // keeps a guaranteed-dead request off the wire mid-draft.
    await expect(fetchProfile(-16034)).rejects.toThrow(/no athlete profile/i)
    await expect(fetchProfile(-14001)).rejects.toThrow(/no athlete profile/i)
  })
})
