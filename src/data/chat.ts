import Anthropic from '@anthropic-ai/sdk'
import type { DraftContext } from '../domain/chatContext'
import type { ChatMessage, ChatSource } from '../domain/types'
import { asScoutError } from './scout'
import { ScoutError } from './scoutError'

const MODEL = 'claude-opus-5'

/**
 * Headroom, not a target.
 *
 * Answers here are meant to be a paragraph, so this is never the binding
 * constraint on length — but thinking is on by default on this model and its
 * tokens come out of the same budget, so a ceiling sized for the visible
 * answer alone truncates mid-sentence on the questions that needed the most
 * reasoning. Streaming means a high ceiling costs nothing in latency or
 * timeout risk, and output is billed by what is actually produced.
 */
const MAX_TOKENS = 16000

/**
 * Searches per turn. Lower than the scout's six — that call is *about* the
 * news, this one is usually about our own roster and only occasionally reaches
 * for the web.
 */
const MAX_SEARCHES = 4

export interface ChatRequest {
  /** The conversation so far, ending with the question just asked. */
  messages: ChatMessage[]
  context: DraftContext
}

/**
 * What the UI gets as the answer arrives.
 *
 * `searching` carries no query: the query streams in as partial JSON and
 * assembling it live would buy one word of extra detail for a chunk of state
 * machine. The finished list arrives with `done`.
 */
export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'searching' }
  | {
      type: 'done'
      searches: string[]
      sources: ChatSource[]
      /** The answer stopped at the token ceiling rather than finishing. */
      truncated?: boolean
    }

const SYSTEM = `You are a fantasy football draft assistant, answering questions during a LIVE in-person auction draft. The person reading you is on a phone, in a room where someone is counting down a bid. They have seconds, not minutes.

You are given the league's full ranking board, the user's roster and budget, and the current state of the room. Everything you need to answer a question about the draft is already in front of you — read it rather than searching for it.

That state is rebuilt for every question and is current as of this one. Anything you said earlier in this conversation was written against an older draft: players have been bought since, the budget has moved, and the max bid has almost certainly changed. Where your own earlier answer disagrees with the state below, the state below is right and you were talking about a draft that no longer exists. Do not repeat a figure from an earlier turn without checking it against the current numbers.

How to answer:
- Lead with the answer. A recommendation, a number, a name. Then at most two short sentences of why.
- Never restate the board back at them. They can see it. Tell them the thing they cannot see: the implication.
- Whole dollars. No ranges unless the range is the point.
- Plain text. No markdown headers, no tables, no bullet lists longer than three items.

Hard rules:
- Never suggest a bid above the stated max bid. It is not a guideline; it is what the budget can physically cover while still filling the roster.
- Never suggest a player listed as taken. They are gone.
- A value written with a leading "~" is our own estimate, not a published one. Keep the "~" when you quote it, and say it is our estimate if it is load-bearing.
- We record that a player is gone, never who bought them. You cannot know what any specific rival team has spent or has left. Speak about "the field" or "a typical rival" and never about a named opponent.
- If the board does not contain something you were asked about, say so. Do not fill the gap with a guess about this league.

Use web search only for things the board cannot know: breaking injury news, a depth-chart change, a trade from this week. Recency is the only reason to search. Do not search to look up a player's general reputation or season projection — that is already in the data you were given.`

/**
 * Streams one answer.
 *
 * The context arrives in two system blocks, and the split is deliberate. Block
 * one — the rules and the whole ranking board — is identical on every turn of
 * a draft, so it carries the cache breakpoint and gets re-read at a tenth of
 * the price. Block two is the draft state, which moves on every pick and so
 * sits *after* the breakpoint where changing it costs nothing.
 *
 * A one-hour TTL rather than the default five minutes: chat turns during a
 * draft are minutes apart, and at five minutes almost every one would miss.
 */
export async function* streamChat(apiKey: string, req: ChatRequest): AsyncGenerator<ChatDelta> {
  const client = new Anthropic({
    apiKey,
    // Same tradeoff as the scout: no backend by design, the key is the user's
    // own and lives on their own device. See README.
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
  })

  const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
    role: m.role,
    content: m.text,
  }))

  const searches: string[] = []
  const sources: ChatSource[] = []

  try {
    // A search-heavy turn can hit the server-side tool-iteration cap and come
    // back as `pause_turn`; resuming just means sending it back. Same ladder
    // as the scout, and the same cap on resumes so a loop cannot bill forever.
    let truncated = false
    for (let resume = 0; ; resume++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: `${SYSTEM}\n\n${req.context.reference}`,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          { type: 'text', text: req.context.live },
        ],
        // Thinking stays on at low effort, as in the scout: with it disabled
        // this model can emit a tool call as plain text, which would silently
        // skip the search. Low because the answer has to arrive while the
        // bidding is still open.
        output_config: { effort: 'low' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES }],
        messages,
      } as Anthropic.MessageStreamParams)

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text }
        } else if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'server_tool_use'
        ) {
          yield { type: 'searching' }
        }
      }

      const response = await stream.finalMessage()
      collect(response.content, searches, sources)

      if (response.stop_reason === 'refusal') {
        throw new ScoutError('Claude declined to answer that', 'refusal')
      }
      if (response.stop_reason !== 'pause_turn') {
        // Cut off at the ceiling. The half-answer is still worth showing —
        // it is the top of the reply, which is where this prompt puts the
        // recommendation — but it must not be badged as a finished one.
        truncated = response.stop_reason === 'max_tokens'
        break
      }
      // Out of resumes with the turn still paused: whatever we have is a
      // fragment of a longer answer, same as hitting the ceiling.
      if (resume >= 3) {
        truncated = true
        break
      }
      messages.push({ role: 'assistant', content: response.content })
    }

    yield { type: 'done', searches, sources, truncated }
  } catch (err) {
    // The failure taxonomy is shared on purpose: it is the same client, the
    // same account and the same set of things that can go wrong, and
    // `ScoutError.kind` is described in `scoutError.ts` as part of the adapter
    // seam rather than as something private to the scout.
    throw asScoutError(err)
  }
}

/**
 * Pulls the search queries and cited pages out of a finished message.
 *
 * Read from the final message rather than assembled from the stream: the query
 * arrives as partial JSON across several deltas, and the result blocks arrive
 * whole anyway. Deduplicated by URL because a two-search turn routinely cites
 * the same beat writer twice.
 */
export function collect(
  content: Anthropic.ContentBlock[],
  searches: string[],
  sources: ChatSource[],
): void {
  const seen = new Set(sources.map((s) => s.url))
  for (const block of content) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      const query = (block.input as { query?: unknown } | null)?.query
      if (typeof query === 'string' && query.trim()) searches.push(query.trim())
    }
    if (block.type === 'web_search_tool_result') {
      // An errored search returns a single object here where a successful one
      // returns a list — indexing it blindly would throw inside the catch and
      // surface as a generic failure. Nothing to cite either way.
      if (!Array.isArray(block.content)) continue
      for (const result of block.content) {
        if (result.type !== 'web_search_result' || seen.has(result.url)) continue
        seen.add(result.url)
        sources.push({ title: result.title || result.url, url: result.url })
      }
    }
  }
}
