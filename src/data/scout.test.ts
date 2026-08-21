import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { asScoutError, parseScoutReport, readableApiMessage, scoutPrompt, textOf } from './scout'
import { ScoutError } from './scoutError'
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

/**
 * The API's failures are the drafter's failures: these all used to arrive as
 * `400 {"type":"error",…}` printed into a row on a phone, which says nothing
 * about what to do and buries the Retry button under a wall of braces.
 */
describe('readableApiMessage', () => {
  const body = (message: string) =>
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })

  it('pulls the sentence out of an SDK message', () => {
    const text = readableApiMessage(`400 ${body('Your credit balance is too low.')}`)
    expect(text).toBe('Your credit balance is too low.')
  })

  it('reads a bare error body too', () => {
    expect(readableApiMessage(body('Something went wrong.'))).toBe('Something went wrong.')
  })

  it('passes prose straight through', () => {
    expect(readableApiMessage('Connection refused')).toBe('Connection refused')
  })

  it('shows nothing rather than JSON it cannot unwrap', () => {
    expect(readableApiMessage('500 {not json at all}')).toBe('')
    expect(readableApiMessage(JSON.stringify({ nested: { deep: true } }))).toBe('')
  })

  it('truncates a message too long to read mid-bid', () => {
    const long = readableApiMessage('x'.repeat(400))
    expect(long.length).toBeLessThanOrEqual(160)
    expect(long.endsWith('…')).toBe(true)
  })

  it('ignores anything that is not a string', () => {
    expect(readableApiMessage(undefined)).toBe('')
    expect(readableApiMessage({ message: 'hi' })).toBe('')
  })
})

describe('asScoutError', () => {
  const apiError = (status: number, type: string, message: string) =>
    Anthropic.APIError.generate(
      status,
      { type: 'error', error: { type, message } },
      undefined,
      new Headers(),
    )

  const kindOf = (err: unknown) => {
    const scoutError = asScoutError(err)
    expect(scoutError).toBeInstanceOf(ScoutError)
    return scoutError
  }

  it('names an empty balance as an empty balance', () => {
    // Arrives as a plain 400, so a status-ordered ladder would call it a bad
    // request — true, useless, and not something the drafter can act on.
    const err = kindOf(
      apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the API.'),
    )
    expect(err.kind).toBe('billing')
    expect(err.message).toMatch(/credit/i)
    expect(err.message).not.toContain('{')
  })

  it('recognises the billing error type whatever the wording says', () => {
    expect(kindOf(apiError(400, 'billing_error', 'Payment required.')).kind).toBe('billing')
  })

  it('sends a rejected key back to Settings', () => {
    const err = kindOf(apiError(401, 'authentication_error', 'invalid x-api-key'))
    expect(err.kind).toBe('auth')
    expect(err.message).toMatch(/Settings/)
  })

  it('treats a forbidden key as a key problem, not a mystery', () => {
    expect(kindOf(apiError(403, 'permission_error', 'not allowed')).kind).toBe('auth')
  })

  it('asks for patience on a rate limit or an overload', () => {
    expect(kindOf(apiError(429, 'rate_limit_error', 'slow down')).kind).toBe('rate-limit')
    expect(kindOf(apiError(529, 'overloaded_error', 'overloaded')).message).toMatch(/busy/i)
    expect(kindOf(apiError(500, 'api_error', 'boom')).message).toMatch(/busy/i)
  })

  it('keeps an unknown API failure in English, with the reason appended', () => {
    const err = kindOf(apiError(400, 'invalid_request_error', 'max_tokens too large'))
    expect(err.kind).toBe('other')
    expect(err.message).toBe('Claude could not run this check: max_tokens too large')
  })

  it('still says something when the body carries no message', () => {
    const err = kindOf(Anthropic.APIError.generate(400, {}, undefined, new Headers()))
    expect(err.message).toBe('Claude could not run this check')
    expect(err.message).not.toContain('{')
  })

  it('passes a ScoutError through untouched', () => {
    const original = new ScoutError('Claude declined to answer for this player', 'refusal')
    expect(asScoutError(original)).toBe(original)
  })

  it('names a connection failure as one', () => {
    const err = kindOf(new Anthropic.APIConnectionError({ message: 'fetch failed' }))
    expect(err.kind).toBe('network')
    expect(err.message).toMatch(/connection/i)
  })

  it('falls back to a retryable sentence for anything else', () => {
    expect(kindOf(new Error('')).message).toBe('Scout failed — retry')
    expect(kindOf('a string').message).toBe('Scout failed — retry')
  })
})
