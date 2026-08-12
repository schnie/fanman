import { describe, it, expect } from 'vitest'
import { parseScoutReport, scoutPrompt, textOf } from './scout'
import type { Player } from '../domain/types'
import { makePlayer } from '../test/factories'

const player = (over: Partial<Player> = {}): Player =>
  makePlayer({ name: 'Jahmyr Gibbs', injuryStatus: 'ACTIVE', ...over })

const REPORT = {
  verdict: 'CAUTION',
  headline: 'Limited in practice Wednesday with a hamstring.',
  notes: ['Coach called him day-to-day.', 'Backup took first-team reps.'],
  sources: [{ title: 'Beat writer', url: 'https://example.com/a' }],
}

describe('scoutPrompt', () => {
  it('names the player and position', () => {
    const prompt = scoutPrompt(player())
    expect(prompt).toContain('Jahmyr Gibbs')
    expect(prompt).toContain('RB')
  })

  it('passes on a non-active injury status as a lead', () => {
    expect(scoutPrompt(player({ injuryStatus: 'QUESTIONABLE' }))).toContain('QUESTIONABLE')
  })

  it('stays quiet when the player is healthy', () => {
    // "ACTIVE" is the default for everyone; repeating it would just be noise.
    expect(scoutPrompt(player())).not.toContain('ACTIVE')
  })
})

describe('parseScoutReport', () => {
  it('reads a clean JSON response', () => {
    const r = parseScoutReport(JSON.stringify(REPORT), 42)
    expect(r.playerId).toBe(42)
    expect(r.verdict).toBe('CAUTION')
    expect(r.headline).toBe(REPORT.headline)
    expect(r.notes).toHaveLength(2)
    expect(r.sources[0].url).toBe('https://example.com/a')
    expect(r.fetchedAt).toBeGreaterThan(0)
  })

  it('reads JSON wrapped in a code fence', () => {
    const text = 'Here you go:\n```json\n' + JSON.stringify(REPORT) + '\n```'
    expect(parseScoutReport(text, 1).verdict).toBe('CAUTION')
  })

  it('reads JSON embedded in prose', () => {
    // Fallback for if structured outputs are ignored alongside the search tool.
    const text = `I searched and found this. ${JSON.stringify(REPORT)} Hope that helps.`
    expect(parseScoutReport(text, 1).headline).toBe(REPORT.headline)
  })

  it('treats an unrecognised verdict as CAUTION, never as all-clear', () => {
    const text = JSON.stringify({ ...REPORT, verdict: 'PROBABLY_FINE' })
    expect(parseScoutReport(text, 1).verdict).toBe('CAUTION')
  })

  it('survives missing notes and sources', () => {
    const r = parseScoutReport(JSON.stringify({ verdict: 'GREEN', headline: 'Nothing new.' }), 1)
    expect(r.verdict).toBe('GREEN')
    expect(r.notes).toEqual([])
    expect(r.sources).toEqual([])
  })

  it('substitutes a placeholder rather than an empty headline', () => {
    const r = parseScoutReport(JSON.stringify({ verdict: 'GREEN', headline: '   ' }), 1)
    expect(r.headline).toBe('No summary returned')
  })

  it('caps notes at three and sources at four', () => {
    const text = JSON.stringify({
      ...REPORT,
      notes: ['a', 'b', 'c', 'd', 'e'],
      sources: Array.from({ length: 9 }, (_, i) => ({ title: `s${i}`, url: `https://x/${i}` })),
    })
    const r = parseScoutReport(text, 1)
    expect(r.notes).toHaveLength(3)
    expect(r.sources).toHaveLength(4)
  })

  it('drops sources with no url and falls back to the url as a title', () => {
    const text = JSON.stringify({
      ...REPORT,
      sources: [{ title: 'ok', url: 'https://x/1' }, { title: 'broken' }, { url: 'https://x/2' }],
    })
    const r = parseScoutReport(text, 1)
    expect(r.sources).toHaveLength(2)
    expect(r.sources[1].title).toBe('https://x/2')
  })

  it('throws when there is no JSON to find', () => {
    expect(() => parseScoutReport('I could not find anything.', 1)).toThrow(/readable report/)
  })
})

describe('textOf', () => {
  it('joins text blocks and ignores tool blocks', () => {
    const content = [
      { type: 'server_tool_use', text: undefined },
      { type: 'web_search_tool_result' },
      { type: 'text', text: '{"verdict":' },
      { type: 'text', text: '"GREEN"}' },
    ]
    expect(textOf(content)).toBe('{"verdict":\n"GREEN"}')
  })

  it('returns an empty string when a turn produced only tool calls', () => {
    expect(textOf([{ type: 'server_tool_use' }])).toBe('')
  })
})
