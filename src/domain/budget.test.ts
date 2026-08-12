import { describe, it, expect } from 'vitest'
import { summarize, canBid, previewBid, picksByPlayer, wonPicks } from './budget'
import { emptyDraft, type DraftState, type Pick } from './types'

const won = (playerId: number, price: number): Pick => ({
  playerId,
  status: 'mine',
  price,
  at: 0,
})
const gone = (playerId: number): Pick => ({ playerId, status: 'gone', price: 0, at: 0 })

const draft = (log: Pick[], budget = 200, slots = 16): DraftState => ({
  ...emptyDraft({ budget, slots, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 }),
  log,
})

describe('summarize', () => {
  it('reserves $1 for every other open slot at the start of a draft', () => {
    const s = summarize(draft([]))
    expect(s.remaining).toBe(200)
    expect(s.slotsLeft).toBe(16)
    expect(s.maxBid).toBe(185) // 200 - 15
  })

  it('collapses to $1 max bid after spending the whole max on one player', () => {
    const s = summarize(draft([won(1, 185)]))
    expect(s.remaining).toBe(15)
    expect(s.slotsLeft).toBe(15)
    expect(s.maxBid).toBe(1)
  })

  it('lets the entire remainder go on the final slot', () => {
    // 15 slots filled for $1 each, one slot left, $185 unspent.
    const log = Array.from({ length: 15 }, (_, i) => won(i + 1, 1))
    const s = summarize(draft(log))
    expect(s.slotsLeft).toBe(1)
    expect(s.maxBid).toBe(185)
    expect(s.maxBid).toBe(s.remaining)
  })

  it('zeroes out max bid and flags a full roster', () => {
    const log = Array.from({ length: 16 }, (_, i) => won(i + 1, 1))
    const s = summarize(draft(log))
    expect(s.slotsLeft).toBe(0)
    expect(s.maxBid).toBe(0)
    expect(s.rosterFull).toBe(true)
    expect(s.avgPerSlot).toBe(0) // no divide-by-zero leaking through
  })

  it('never reports a negative max bid even if overspent', () => {
    // Defensive: shouldn't be reachable through the UI, but the math must hold.
    const s = summarize(draft([won(1, 199), won(2, 1)], 200, 16))
    expect(s.remaining).toBe(0)
    expect(s.maxBid).toBe(0)
  })

  it('ignores crossed-off players entirely', () => {
    const s = summarize(draft([gone(1), gone(2), gone(3)]))
    expect(s.spent).toBe(0)
    expect(s.filled).toBe(0)
    expect(s.maxBid).toBe(185)
  })

  it('tracks spend and fill across a realistic run', () => {
    const s = summarize(draft([won(1, 57), gone(2), won(3, 41), gone(4), won(5, 22)]))
    expect(s.spent).toBe(120)
    expect(s.filled).toBe(3)
    expect(s.remaining).toBe(80)
    expect(s.slotsLeft).toBe(13)
    expect(s.maxBid).toBe(68) // 80 - 12
  })

  it('honours non-default league settings', () => {
    const s = summarize(draft([], 300, 20))
    expect(s.maxBid).toBe(281) // 300 - 19
  })

  it('handles a one-slot league', () => {
    const s = summarize(draft([], 50, 1))
    expect(s.maxBid).toBe(50)
  })
})

describe('picksByPlayer', () => {
  it('lets a later entry supersede an earlier one for the same player', () => {
    const state = draft([gone(7), won(7, 12)])
    expect(picksByPlayer(state).get(7)?.status).toBe('mine')
    expect(summarize(state).spent).toBe(12)
  })

  it('does not double-count a player re-recorded at a new price', () => {
    const state = draft([won(7, 12), won(7, 20)])
    expect(wonPicks(state)).toHaveLength(1)
    expect(summarize(state).spent).toBe(20)
  })
})

describe('canBid', () => {
  it('accepts a bid at exactly the max', () => {
    expect(canBid(draft([]), 185)).toBe(true)
  })

  it('rejects a bid one dollar over the max', () => {
    expect(canBid(draft([]), 186)).toBe(false)
  })

  it('rejects sub-minimum, fractional, and nonsense bids', () => {
    const d = draft([])
    expect(canBid(d, 0)).toBe(false)
    expect(canBid(d, -5)).toBe(false)
    expect(canBid(d, 12.5)).toBe(false)
    expect(canBid(d, NaN)).toBe(false)
  })

  it('rejects any bid once the roster is full', () => {
    const log = Array.from({ length: 16 }, (_, i) => won(i + 1, 1))
    expect(canBid(draft(log), 1)).toBe(false)
  })
})

describe('previewBid', () => {
  it('reports the post-win budget without mutating current state', () => {
    const state = draft([])
    const preview = previewBid(state, 99, 60)
    expect(preview.remaining).toBe(140)
    expect(preview.slotsLeft).toBe(15)
    expect(preview.maxBid).toBe(126) // 140 - 14
    expect(state.log).toHaveLength(0) // untouched
    expect(summarize(state).remaining).toBe(200)
  })
})
