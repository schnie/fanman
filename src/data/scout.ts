import Anthropic from '@anthropic-ai/sdk'
import { VERDICTS, type Player, type ScoutReport, type Verdict } from '../domain/types'
import { ScoutError } from './scoutError'

const MODEL = 'claude-opus-5'

/**
 * The shape we want back. Also handed to the model as a JSON schema, so the UI
 * can render a chip without defensive string parsing.
 */
export const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: VERDICTS,
      description:
        'GREEN: nothing found that changes the pick. CAUTION: something a bidder should weigh. RED: materially damaging news.',
    },
    headline: {
      type: 'string',
      description: 'One short sentence, under 90 characters, readable at a glance mid-bid.',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to three terse findings. Empty if nothing of note.',
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['title', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'headline', 'notes', 'sources'],
  additionalProperties: false,
}

const SYSTEM = `You are checking a fantasy football player for last-minute news during a LIVE auction draft. The person reading you is about to bid real money in the next few seconds.

Search for news from the last two weeks about: injuries, depth-chart changes, trades, suspensions, holdouts, and coaching or scheme changes that affect this player's workload.

Rules:
- Recency is everything. A season-old story is noise. Ignore anything that is not new information.
- Do not restate general scouting opinion, season projections, or draft rankings. The drafter already has those.
- If you find nothing recent and material, that is a GREEN with an explicit "nothing new" headline. Saying so plainly is a useful answer, not a failure.
- Reserve RED for news that clearly reduces this player's value: a significant injury, a lost starting job, a suspension.
- Be terse. Every word costs the drafter time they do not have.`

/** Only the fields the model needs. Keeps the prompt (and the cache key) stable. */
export function scoutPrompt(player: Player): string {
  return [
    `Player: ${player.name}`,
    `Position: ${player.position}`,
    player.injuryStatus && player.injuryStatus !== 'ACTIVE'
      ? `ESPN currently lists them as: ${player.injuryStatus}`
      : null,
    '',
    'Search for anything from the last two weeks that should change how much I bid on this player right now.',
  ]
    .filter(Boolean)
    .join('\n')
}

interface RawReport {
  verdict: Verdict
  headline: string
  notes: string[]
  sources: { title: string; url: string }[]
}

/**
 * Pulls the report out of a response.
 *
 * Structured outputs should make this a straight read of the first text block,
 * but this also tolerates the model wrapping the object in prose or a fenced
 * code block. That fallback matters because the interaction between structured
 * outputs and the server-side search tool could not be verified without a key —
 * if the schema is silently ignored, the scout still works.
 */
export function parseScoutReport(text: string, playerId: number): ScoutReport {
  const raw = extractJson(text)
  if (!raw) throw new Error('Scout returned no readable report')

  // An unrecognised verdict is never treated as an all-clear.
  const verdict: Verdict = VERDICTS.includes(raw.verdict as Verdict)
    ? (raw.verdict as Verdict)
    : 'CAUTION'

  return {
    playerId,
    verdict,
    headline: String(raw.headline ?? '').trim() || 'No summary returned',
    notes: Array.isArray(raw.notes) ? raw.notes.map(String).slice(0, 3) : [],
    sources: Array.isArray(raw.sources)
      ? raw.sources
          .filter((s) => s && typeof s.url === 'string')
          .map((s) => ({ title: String(s.title ?? s.url), url: String(s.url) }))
          .slice(0, 4)
      : [],
    fetchedAt: Date.now(),
  }
}

function extractJson(text: string): Partial<RawReport> | null {
  const candidates = [text.trim()]

  // ```json … ``` fences, then the outermost brace pair.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1].trim())

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Partial<RawReport>
    } catch {
      // try the next shape
    }
  }
  return null
}

/** Concatenated text of every text block in a response. */
export function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
}

/**
 * One Claude call with the server-side web-search tool. The agentic part —
 * issuing searches, reading results, deciding when it has enough — runs on
 * Anthropic's servers, so from here it is a single request.
 */
export async function scoutPlayer(apiKey: string, player: Player): Promise<ScoutReport> {
  const client = new Anthropic({
    apiKey,
    // This app has no backend by design; the key is the user's own, on their
    // own device. See README for the tradeoff.
    dangerouslyAllowBrowser: true,
    maxRetries: 1, // a draft does not wait for a long retry ladder
  })

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: scoutPrompt(player) },
  ]

  try {
    // A search-heavy turn can hit the server-side tool-iteration cap and come
    // back as `pause_turn`; resuming just means sending it back.
    let response = await create(client, messages)
    for (let resume = 0; response.stop_reason === 'pause_turn' && resume < 3; resume++) {
      messages.push({ role: 'assistant', content: response.content })
      response = await create(client, messages)
    }

    if (response.stop_reason === 'refusal') {
      throw new ScoutError('Claude declined to answer for this player', 'refusal')
    }

    return parseScoutReport(textOf(response.content), player.id)
  } catch (err) {
    throw asScoutError(err)
  }
}

function create(client: Anthropic, messages: Anthropic.MessageParam[]) {
  return client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    // Thinking stays on (the default) at low effort: disabling it on this model
    // risks tool calls being emitted as plain text, which would silently skip
    // the search entirely.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCOUT_SCHEMA },
    },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming)
}

/**
 * Pulls the one human sentence out of whatever an API failure carries.
 *
 * The SDK builds its `message` as `"400 {…the whole JSON body…}"`, and that
 * string used to land straight in the row: a wall of braces where a reason
 * should be, on a phone, mid-bid. Anything that still looks like JSON after
 * unwrapping is dropped rather than shown — no detail at all beats a detail
 * made of punctuation, and the kind-specific prose below already says what to
 * do next.
 *
 * Exported for its tests, and used on the generic path too, so an adapter that
 * hands us a raw body string gets the same treatment.
 */
export function readableApiMessage(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.trim().replace(/^\d{3}\s+/, '') // the SDK's status prefix
  if (!text) return ''

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last <= first) return isProse(text) ? cap(text) : ''

  try {
    const body = JSON.parse(text.slice(first, last + 1)) as {
      message?: unknown
      error?: { message?: unknown }
    }
    const inner = body?.error?.message ?? body?.message
    return typeof inner === 'string' ? cap(inner.trim()) : ''
  } catch {
    return '' // unparseable braces: still not something to put in front of a bidder
  }
}

/**
 * Is this something a person wrote, or something a machine emitted?
 *
 * The SDK passes an unparseable body straight through as the message, so on
 * venue wifi a captive portal or an intercepting proxy answering with an HTML
 * page lands here — and a row rendering `<!DOCTYPE html><html><head><title>407`
 * is the same failure as rendering the JSON, in a different alphabet. Markup,
 * a string with no words in it, and the SDK's own `"<status> status code (no
 * body)"` filler are all dropped in favour of the generic sentence.
 */
function isProse(text: string): boolean {
  if (/[<>{}]/.test(text)) return false
  if (!/[a-z]/i.test(text)) return false
  return !/^status code\b/i.test(text)
}

/** Long enough for a real API sentence, short enough not to bury the retry. */
function cap(text: string): string {
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text
}

/**
 * Maps a thrown thing onto a `kind` and a sentence that says what to do next.
 *
 * Every branch names an action, because the panel rendering this also renders
 * a Retry button: the drafter has one tap and a few seconds to decide whether
 * this is worth waiting for.
 *
 * Exported for its tests — the branches are the whole behaviour.
 */
export function asScoutError(err: unknown): ScoutError {
  if (err instanceof ScoutError) return err
  if (err instanceof Anthropic.APIConnectionError) {
    return new ScoutError('Could not reach Claude — check the connection, then retry', 'network')
  }

  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: unknown } } | undefined
    const detail = readableApiMessage(body?.error?.message) || readableApiMessage(err.message)
    const status = err.status ?? 0

    // Billing first: an exhausted balance arrives as a plain 400, so a
    // status-ordered ladder files "you are out of credit" under "bad request"
    // and tells the drafter nothing they can act on. Match the body type, and
    // the wording too, in case a gateway in front of it is older than the type.
    if (err.type === 'billing_error' || /credit balance|billing/i.test(detail)) {
      return new ScoutError(
        'Out of Claude API credit — add credit at console.anthropic.com, then retry',
        'billing',
      )
    }
    if (status === 401 || err.type === 'authentication_error') {
      return new ScoutError('API key rejected — check it in Settings, then retry', 'auth')
    }
    if (status === 403 || err.type === 'permission_error') {
      return new ScoutError('This API key is not allowed to scout — check it in Settings', 'auth')
    }
    if (status === 429 || err.type === 'rate_limit_error') {
      return new ScoutError('Rate limited — retry in a moment', 'rate-limit')
    }
    if (status >= 500 || err.type === 'overloaded_error') {
      return new ScoutError('Claude is busy right now — retry in a moment', 'other')
    }
    return new ScoutError(
      detail ? `Claude could not run this check: ${detail}` : 'Claude could not run this check',
      'other',
    )
  }

  const message = err instanceof Error ? readableApiMessage(err.message) : ''
  return new ScoutError(message || 'Scout failed — retry', 'other')
}
