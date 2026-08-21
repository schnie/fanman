import { describe, it, expect } from 'vitest'
import { parseByeWeeks } from './byes'

/** Trimmed from a real 2026 `proTeamSchedules_wl` response. */
const body = {
  settings: {
    proTeams: [
      { id: 12, abbrev: 'KC', byeWeek: 5 },
      { id: 34, abbrev: 'HOU', byeWeek: 8 },
      // The free-agent bucket rides along in the same array, with no bye.
      { id: 0, abbrev: 'FA', byeWeek: 0 },
    ],
  },
}

describe('parseByeWeeks', () => {
  it('maps pro team ids to their bye week', () => {
    const byes = parseByeWeeks(body)
    expect(byes.get(12)).toBe(5)
    expect(byes.get(34)).toBe(8)
  })

  it('drops the free-agent bucket rather than storing a week 0', () => {
    const byes = parseByeWeeks(body)
    // Not `toBe(0)`: a zero here would render as a "Bye 0" chip, which reads
    // as a fact rather than as the absence of one.
    expect(byes.has(0)).toBe(false)
    expect(byes.size).toBe(2)
  })

  it('survives a payload that has moved or is empty', () => {
    expect(parseByeWeeks({}).size).toBe(0)
    expect(parseByeWeeks(null).size).toBe(0)
    expect(parseByeWeeks({ settings: {} }).size).toBe(0)
    expect(parseByeWeeks({ settings: { proTeams: [{ abbrev: 'KC' }] } }).size).toBe(0)
  })
})
