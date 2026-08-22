import { describe, it, expect } from 'vitest'
import { sendableHistory } from './useChat'
import type { ChatTurn } from './domain/types'

let n = 0
const turn = (role: ChatTurn['role'], text: string, failed = false): ChatTurn => ({
  id: String(++n),
  role,
  text,
  at: n,
  ...(failed ? { failed: true } : {}),
})

const user = (t: string) => turn('user', t)
const bot = (t: string) => turn('assistant', t)
const bad = (t: string) => turn('assistant', t, true)
const line = () => turn('divider', '')

const texts = (turns: ChatTurn[], limit?: number) =>
  sendableHistory(turns, limit).map((m) => m.text)

describe('sendableHistory', () => {
  it('sends an intact conversation through in order', () => {
    expect(sendableHistory([user('q1'), bot('a1'), user('q2')])).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2' },
    ])
  })

  it('is empty for an empty transcript', () => {
    expect(sendableHistory([])).toEqual([])
  })

  /**
   * The model has no use for our error prose, and a rejected-key sentence
   * would otherwise poison every later question with a paragraph about a
   * rejected key.
   */
  it('never sends a failed turn back', () => {
    expect(texts([user('q1'), bad('half an answer'), bad('Rate limited'), user('q2')])).toEqual([
      'q1',
      'q2',
    ])
  })

  it('drops everything up to and including the last divider', () => {
    expect(texts([user('q1'), bot('a1'), line(), user('q2'), bot('a2')])).toEqual(['q2', 'a2'])
  })

  it('resets to nothing when the divider is the last thing there', () => {
    expect(texts([user('q1'), bot('a1'), line()])).toEqual([])
  })

  it('honours only the most recent of several dividers', () => {
    expect(texts([user('q1'), line(), user('q2'), line(), user('q3')])).toEqual(['q3'])
  })

  it('windows a long conversation to the most recent turns', () => {
    const many = Array.from({ length: 10 }, (_, i) => user(`q${i}`))
    expect(texts(many, 4)).toEqual(['q6', 'q7', 'q8', 'q9'])
  })

  /**
   * The load-bearing ordering. If the window were applied before the divider
   * search, a divider sitting further back than the limit would fall outside
   * the slice and silently stop working — the rule would render on screen
   * while the model read straight through it.
   */
  it('finds a divider that sits further back than the window', () => {
    const turns = [
      user('ancient'),
      line(),
      ...Array.from({ length: 6 }, (_, i) => user(`q${i}`)),
    ]
    // A window of 3 keeps only the last three — but must still start after the
    // divider, never before it.
    expect(texts(turns, 3)).toEqual(['q3', 'q4', 'q5'])
    expect(texts(turns, 3)).not.toContain('ancient')
  })

  it('applies the window to what survives the divider, not to the raw list', () => {
    const turns = [user('a'), user('b'), user('c'), line(), user('d'), user('e')]
    expect(texts(turns, 10)).toEqual(['d', 'e'])
  })

  /**
   * The API rejects a message list that opens on an assistant turn. Alternating
   * turns make that look unreachable, but a failure appends two turns and drops
   * both while its question survives — so one failure earlier in a topic makes
   * the surviving list odd and the window opens mid-exchange.
   */
  it('never opens on an answer, even when a failure has skewed the history', () => {
    const turns = [
      user('q1'), bot('a1'), user('q2'), bot('a2'),
      user('q3'), bad('half'), bad('Rate limited'),
      user('q4'), bot('a4'), user('q5'), bot('a5'),
      user('q6'), bot('a6'), user('q7'), bot('a7'),
    ]
    const out = sendableHistory(turns)
    expect(out[0].role).toBe('user')
    expect(out[0].text).toBe('q2')
  })

  it('opens on a user turn for every window size', () => {
    const turns = [
      user('q1'), bot('a1'), user('q2'), bad('oops'), user('q3'), bot('a3'), user('q4'),
    ]
    for (let limit = 1; limit <= 8; limit++) {
      const out = sendableHistory(turns, limit)
      if (out.length > 0) expect(out[0].role, `limit ${limit}`).toBe('user')
    }
  })

  /**
   * An answer that produced no text would go back as an empty content block,
   * which the API rejects — one silent blank would break the rest of the topic.
   */
  it('drops a turn with no text in it', () => {
    expect(texts([user('q1'), bot('   '), user('q2')])).toEqual(['q1', 'q2'])
  })

  it('combines all three rules', () => {
    const turns = [
      user('dropped by divider'),
      line(),
      user('q1'),
      bad('failed'),
      user('q2'),
      bot('a2'),
      user('q3'),
    ]
    expect(texts(turns, 3)).toEqual(['q2', 'a2', 'q3'])
  })
})
