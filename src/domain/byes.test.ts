import { describe, it, expect } from 'vitest'
import { byeCounts, byeLoads } from './byes'
import type { Pick, Player } from './types'
import { makePlayer } from '../test/factories'

/** `[id, position, byeWeek, price]` — price is what decides slot order. */
type Spec = [id: number, position: string, byeWeek: number | undefined, price: number]

function roster(specs: Spec[]) {
  const players: Player[] = specs.map(([id, position, byeWeek]) =>
    makePlayer({ id, name: `P${id}`, position, byeWeek }),
  )
  const won: Pick[] = specs.map(([id, , , price]) => ({
    playerId: id,
    status: 'mine',
    price,
    at: id,
  }))
  return { won, byId: new Map(players.map((p) => [p.id, p])) }
}

describe('byeLoads', () => {
  it('reports no hole when a bench player can refill the slot', () => {
    // Three starting slots (QB, RB, RB) and four players, so one back is
    // genuinely idle — that's what cover means.
    const { won, byId } = roster([
      [1, 'RB', 5, 40],
      [2, 'RB', 9, 30],
      [3, 'QB', 9, 20],
      [4, 'RB', 9, 10],
    ])
    const week5 = byeLoads(won, byId, 3).find((l) => l.week === 5)!

    expect(week5.players.map((p) => p.id)).toEqual([1])
    expect(week5.starters).toBe(1)
    expect(week5.holes).toBe(0)
  })

  it('counts the hole when the only bodies left are already starting', () => {
    // Two backs out, one spare to replace them: the spare fills one slot, and
    // the other stays empty. A player already in the lineup is not cover.
    const { won, byId } = roster([
      [1, 'RB', 5, 40],
      [2, 'RB', 5, 30],
      [3, 'RB', 9, 20],
    ])
    const [week5] = byeLoads(won, byId, 3)

    expect(week5.week).toBe(5)
    expect(week5.players.map((p) => p.id)).toEqual([1, 2]) // dearest first
    expect(week5.starters).toBe(2)
    expect(week5.holes).toBe(1)
    expect(week5.uncovered).toEqual(['RB'])
  })

  it('names the slots that go empty, not just how many', () => {
    // A back and a receiver out the same week empty one of each. Naming them
    // is what tells you which position to go shopping for.
    const { won, byId } = roster([
      [1, 'QB', 9, 50],
      [2, 'RB', 5, 40],
      [3, 'WR', 5, 30],
    ])
    const week5 = byeLoads(won, byId, 5).find((l) => l.week === 5)!

    expect(week5.uncovered).toEqual(['RB', 'WR'])
    expect(week5.holes).toBe(2)
  })

  it('never charges one position for another position\'s bye', () => {
    // The whole point of asking the lineup builder: two receivers off in week
    // 5 empty receiver slots. The quarterback's week is untouched, and his own
    // week costs exactly one slot.
    const { won, byId } = roster([
      [1, 'QB', 9, 50],
      [2, 'WR', 5, 40],
      [3, 'WR', 5, 30],
    ])
    const loads = byeLoads(won, byId, 5)

    expect(loads.find((l) => l.week === 5)!.uncovered).toEqual(['WR', 'WR'])
    expect(loads.find((l) => l.week === 9)!.uncovered).toEqual(['QB'])
  })

  it('implicates only the positions that could have filled the empty slot', () => {
    // A back and a receiver off the same week, but four receivers on the
    // roster — the receiver's slot refills and the back's doesn't. The week is
    // short at back only, and the receiver is not part of the problem.
    const { won, byId } = roster([
      [1, 'RB', 6, 40],
      [2, 'WR', 6, 30],
      [3, 'WR', 11, 25],
      [4, 'WR', 11, 20],
      [5, 'WR', 11, 15],
    ])
    const week6 = byeLoads(won, byId, 7).find((l) => l.week === 6)!

    expect(week6.uncovered).toEqual(['RB'])
    expect(week6.uncoveredPositions).toEqual(['RB'])
    expect(week6.players.map((p) => p.position)).toEqual(['RB', 'WR']) // both still out
  })

  it('implicates every position the OP slot would have taken', () => {
    // The OP slot is superflex-shaped, so when it goes dark any skill position
    // could have stood in — and the flag has to say so rather than naming the
    // one position whose label happens to be on the slot.
    const { won, byId } = roster([
      [1, 'QB', 9, 50],
      [2, 'RB', 9, 40],
      [3, 'RB', 9, 35],
      [4, 'WR', 9, 30],
      [5, 'WR', 9, 25],
      [6, 'TE', 9, 20],
      [7, 'RB', 6, 15], // the OP body
    ])
    const week6 = byeLoads(won, byId, 7).find((l) => l.week === 6)!

    expect(week6.uncovered).toEqual(['OP'])
    expect(week6.uncoveredPositions).toEqual(['QB', 'RB', 'WR', 'TE'])
  })

  it('lets the superflex OP slot cover across positions', () => {
    // The back in the OP slot is off, and the only spare is a quarterback.
    // This league's OP takes one, so nothing is lost — under a normal FLEX
    // that spare would be ineligible and the week would show a hole.
    const { won, byId } = roster([
      [1, 'QB', 9, 50],
      [2, 'RB', 9, 40],
      [3, 'RB', 9, 35],
      [4, 'WR', 9, 30],
      [5, 'WR', 9, 25],
      [6, 'TE', 9, 20],
      [7, 'RB', 5, 15], // OP
      [8, 'QB', 9, 10], // bench — only a superflex slot can use him
    ])
    const week5 = byeLoads(won, byId, 7).find((l) => l.week === 5)!

    expect(week5.starters).toBe(1)
    expect(week5.holes).toBe(0)
  })

  it('never reports the roster’s own empty slots as bye damage', () => {
    // Two players against fifteen slots: eight starting spots are unfilled
    // anyway. Only the one the bye takes away may be counted, or a half-drafted
    // roster would show a catastrophe in every week it touches.
    const { won, byId } = roster([
      [1, 'RB', 5, 40],
      [2, 'WR', 9, 30],
    ])
    for (const load of byeLoads(won, byId, 15)) expect(load.holes).toBe(1)
    expect(byeLoads(won, byId, 15).map((l) => l.uncovered)).toEqual([['RB'], ['WR']])
  })

  it('ignores players whose bye we never fetched', () => {
    const { won, byId } = roster([
      [1, 'RB', undefined, 40],
      [2, 'WR', 9, 30],
    ])
    expect(byeLoads(won, byId, 15).map((l) => l.week)).toEqual([9])
  })

  it('orders the worst week first', () => {
    const { won, byId } = roster([
      [1, 'RB', 5, 40],
      [2, 'RB', 5, 30], // week 5 costs two slots
      [3, 'RB', 9, 20], // week 9 costs one
    ])
    expect(byeLoads(won, byId, 3).map((l) => l.week)).toEqual([5, 9])
  })

  it('is empty for a roster nobody has won yet', () => {
    expect(byeLoads([], new Map(), 15)).toEqual([])
  })
})

describe('byeCounts', () => {
  it('counts only players at the same position', () => {
    // The receiver sharing week 5 is not the back's problem: he could never
    // have covered that slot, and counting him would flag the row with a
    // number that means nothing.
    const { won, byId } = roster([
      [1, 'RB', 5, 40],
      [2, 'RB', 5, 35],
      [3, 'WR', 5, 30],
      [4, 'TE', 9, 20],
    ])
    const counts = byeCounts(won, byId)

    expect(counts.at('RB', 5)).toBe(2)
    expect(counts.at('WR', 5)).toBe(1)
    expect(counts.at('QB', 5)).toBe(0)
    expect(counts.at('TE', 9)).toBe(1)
    expect(counts.at('TE', 5)).toBe(0)
  })

  it('skips players whose bye we never fetched', () => {
    const { won, byId } = roster([
      [1, 'RB', undefined, 40],
      [2, 'RB', 5, 30],
    ])
    expect(byeCounts(won, byId).at('RB', 5)).toBe(1)
  })
})
