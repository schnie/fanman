import { describe, it, expect } from 'vitest'
import { streamChat } from './chat'
import { buildChatContext } from '../domain/chatContext'
import { summarize, picksByPlayer } from '../domain/budget'
import { summarizeMarket } from '../domain/market'
import { suggestNomination } from '../domain/nomination'
import { DEFAULT_SETTINGS, emptyDraft, type Pick, type Player } from '../domain/types'

/**
 * Makes real, billed Claude calls with live web search.
 *
 *     ANTHROPIC_API_KEY=sk-ant-… npm run test:chat
 *
 * This is the canary for the two things the fixture tests cannot reach: that a
 * ~5K-token board in a cached system block is actually accepted and cached,
 * and that the model respects the hard rules in the prompt when it has a real
 * board in front of it rather than a five-player fixture.
 *
 * Gated exactly like the scout: `FANMAN_LIVE` is set by this script and
 * nothing else, so an exported key in your shell can never make `npm test`
 * spend money. Both switches are required, and asking for the check without a
 * key fails loudly rather than skipping green.
 */
const optedIn = Boolean(process.env.FANMAN_LIVE)
const key = process.env.ANTHROPIC_API_KEY
const live = optedIn && key ? describe : describe.skip
const missingKey = optedIn && !key ? describe : describe.skip

const p = (over: Partial<Player> & { id: number; name: string }): Player => ({
  position: 'RB',
  proTeamId: 8,
  rank: 1,
  espnValue: 40,
  marketValue: 42,
  marketChange: 0,
  adp: 1,
  percentOwned: 99,
  injuryStatus: null,
  injured: false,
  projectedPoints: 250,
  ...over,
})

const BOARD: Player[] = [
  p({ id: 1, name: 'Jahmyr Gibbs', position: 'RB', rank: 1, espnValue: 57, marketValue: 64, byeWeek: 8 }),
  p({ id: 2, name: 'Puka Nacua', position: 'WR', rank: 2, espnValue: 48, marketValue: 46, byeWeek: 9 }),
  p({ id: 3, name: 'Josh Allen', position: 'QB', rank: 3, espnValue: 34, marketValue: 40, byeWeek: 8 }),
  p({ id: 4, name: 'Bijan Robinson', position: 'RB', rank: 4, espnValue: 52, marketValue: 55, byeWeek: 12 }),
  p({ id: 5, name: 'Brock Bowers', position: 'TE', rank: 5, espnValue: 30, marketValue: 33, byeWeek: 10 }),
]

const ABBR: Record<number, string> = { 8: 'DET' }

/** A draft where we already own one back and one is off the board. */
function context(log: Pick[]) {
  const state = { ...emptyDraft(DEFAULT_SETTINGS), log }
  const picks = picksByPlayer(state)
  const market = summarizeMarket(BOARD, picks, DEFAULT_SETTINGS)
  const summary = summarize(state)
  return {
    context: buildChatContext({
      players: BOARD,
      picks,
      summary,
      settings: DEFAULT_SETTINGS,
      market,
      advice: suggestNomination({
        players: BOARD,
        picks,
        summary,
        settings: DEFAULT_SETTINGS,
        market,
      }),
      teamAbbr: (id) => ABBR[id] ?? null,
    }),
    maxBid: summary.maxBid,
  }
}

async function askOnce(question: string, log: Pick[]) {
  const { context: ctx, maxBid } = context(log)
  let text = ''
  let searches: string[] = []
  for await (const delta of streamChat(key!, { messages: [{ role: 'user', text: question }], context: ctx })) {
    if (delta.type === 'text') text += delta.text
    if (delta.type === 'done') searches = delta.searches
  }
  return { text: text.trim(), searches, maxBid }
}

live('chat against the real API', () => {
  it(
    'answers from the board without being told to search',
    { timeout: 120_000 },
    async () => {
      const started = Date.now()
      const { text, searches } = await askOnce('Which quarterback is on the board, and what is his bye week?', [])
      console.log(`\n  ${text}\n  (${((Date.now() - started) / 1000).toFixed(1)}s, ${searches.length} searches)\n`)

      expect(text.length).toBeGreaterThan(0)
      expect(text).toMatch(/Allen/i)
      expect(text).toMatch(/8/)
      // The board already holds this. Searching for it would mean the prompt's
      // "read rather than search" instruction is not landing.
      expect(searches).toHaveLength(0)
    },
  )

  it(
    'will not suggest a player who is already gone',
    { timeout: 120_000 },
    async () => {
      // Both backs off the board; only Nacua, Allen and Bowers remain.
      const log: Pick[] = [
        { playerId: 1, status: 'gone', price: 60, at: 1 },
        { playerId: 4, status: 'gone', price: 55, at: 2 },
      ]
      const { text } = await askOnce('Who is the best running back still available?', log)
      console.log(`\n  ${text}\n`)

      expect(text).not.toMatch(/\bGibbs\b/)
      expect(text).not.toMatch(/\bBijan\b/)
    },
  )

  it(
    'keeps its suggested bid under the max bid',
    { timeout: 120_000 },
    async () => {
      // $180 spent on one player leaves $20 and 14 slots — a $7 ceiling.
      const log: Pick[] = [{ playerId: 1, status: 'mine', price: 180, at: 1 }]
      const { text, maxBid } = await askOnce('What should I bid on Puka Nacua?', log)
      console.log(`\n  max bid $${maxBid}\n  ${text}\n`)

      expect(maxBid).toBe(7)
      // Every dollar figure it names has to be inside what we can actually pay.
      const quoted = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
      const suggested = quoted.filter((n) => n > maxBid && n <= 200)
      expect(
        suggested,
        `named a figure above the $${maxBid} ceiling: ${suggested.join(', ')}`,
      ).toHaveLength(0)
    },
  )
})

missingKey('chat live test', () => {
  it('refuses to report success without a key', () => {
    expect(
      key,
      'The live chat check needs a key: ANTHROPIC_API_KEY=sk-ant-… npm run test:chat',
    ).toBeTruthy()
  })
})
