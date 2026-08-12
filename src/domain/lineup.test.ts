import { describe, it, expect } from 'vitest'
import { buildLineup, STARTER_SLOTS } from './lineup'
import type { Pick, Player } from './types'

let nextId = 1
const roster: Player[] = []

function make(position: string, name = `${position}-${nextId}`): Player {
  const p: Player = {
    id: nextId++,
    name,
    position,
    proTeamId: 1,
    rank: 1,
    espnValue: 10,
    marketValue: 10,
    marketChange: 0,
    adp: 1,
    percentOwned: 50,
    injuryStatus: null,
    injured: false,
    projectedPoints: 100,
  }
  roster.push(p)
  return p
}

const won = (p: Player, price: number): Pick => ({
  playerId: p.id,
  status: 'mine',
  price,
  at: 0,
})

const index = () => new Map(roster.map((p) => [p.id, p]))
const labels = (rows: { label: string }[]) => rows.map((r) => r.label)
const names = (rows: { player?: Player }[]) => rows.map((r) => r.player?.name ?? null)

describe('buildLineup', () => {
  it('lays out an empty roster as the full starting lineup plus bench', () => {
    const lineup = buildLineup([], index(), 16)
    expect(labels(lineup.starters)).toEqual([
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K', 'HC',
    ])
    expect(lineup.bench).toHaveLength(16 - STARTER_SLOTS.length)
    expect(lineup.bench.every((b) => b.label === 'BE')).toBe(true)
    expect(lineup.openStarters).toBe(10)
  })

  it('puts each player in its dedicated slot', () => {
    const qb = make('QB')
    const rb = make('RB')
    const lineup = buildLineup([won(qb, 20), won(rb, 30)], index(), 16)

    expect(lineup.starters[0].player?.name).toBe(qb.name) // QB
    expect(lineup.starters[1].player?.name).toBe(rb.name) // RB1
    expect(lineup.starters[2].player).toBeUndefined() // RB2 still open
    expect(lineup.openStarters).toBe(8)
  })

  it('gives starting slots to the most expensive eligible player', () => {
    const cheap = make('RB', 'cheap-rb')
    const pricey = make('RB', 'pricey-rb')
    const lineup = buildLineup([won(cheap, 5), won(pricey, 55)], index(), 16)

    expect(lineup.starters[1].player?.name).toBe('pricey-rb')
    expect(lineup.starters[2].player?.name).toBe('cheap-rb')
  })

  it('overflows a surplus RB into FLEX', () => {
    const rbs = [make('RB'), make('RB'), make('RB')]
    const lineup = buildLineup(rbs.map((r, i) => won(r, 30 - i)), index(), 16)

    const flex = lineup.starters.find((s) => s.label === 'FLEX')
    expect(flex?.player?.name).toBe(rbs[2].name) // cheapest of the three
    expect(lineup.bench.every((b) => !b.pick)).toBe(true)
  })

  it('fills dedicated slots before FLEX, so a lone TE is not stranded', () => {
    // Regression: filling FLEX first with the only TE would leave the TE slot
    // empty while a WR sat on the bench.
    const te = make('TE', 'only-te')
    const wr1 = make('WR', 'wr-a')
    const wr2 = make('WR', 'wr-b')
    const wr3 = make('WR', 'wr-c')

    // The TE is the cheapest, so a naive value-first pass would bench it.
    const lineup = buildLineup(
      [won(te, 1), won(wr1, 40), won(wr2, 30), won(wr3, 20)],
      index(),
      16,
    )

    expect(lineup.starters.find((s) => s.label === 'TE')?.player?.name).toBe('only-te')
    expect(lineup.starters.find((s) => s.label === 'FLEX')?.player?.name).toBe('wr-c')
  })

  it('benches players with no starting slot left', () => {
    const qbs = [make('QB', 'qb-a'), make('QB', 'qb-b')]
    const lineup = buildLineup(qbs.map((q, i) => won(q, 20 - i)), index(), 16)

    expect(lineup.starters[0].player?.name).toBe('qb-a')
    expect(names(lineup.bench)[0]).toBe('qb-b')
    // A benched QB is labelled by its position, not "BE".
    expect(lineup.bench[0].label).toBe('QB')
  })

  it('gives the head coach its own slot and never confuses it with D/ST', () => {
    const hc = make('HC', 'Chiefs Coach')
    const dst = make('D/ST', 'Chiefs D/ST')
    const lineup = buildLineup([won(hc, 3), won(dst, 5)], index(), 17)

    expect(lineup.starters.find((s) => s.label === 'HC')?.player?.name).toBe('Chiefs Coach')
    expect(lineup.starters.find((s) => s.label === 'D/ST')?.player?.name).toBe('Chiefs D/ST')
    expect(lineup.bench.every((b) => !b.pick)).toBe(true)
  })

  it('keeps a coach out of FLEX', () => {
    // FLEX accepts RB/WR/TE only — a coach must never be pulled into it, even
    // when it is the only unplaced player.
    const hc = make('HC', 'Bills Coach')
    const lineup = buildLineup([won(hc, 2)], index(), 17)

    expect(lineup.starters.find((s) => s.label === 'FLEX')?.pick).toBeUndefined()
    expect(lineup.starters.find((s) => s.label === 'HC')?.player?.name).toBe('Bills Coach')
  })

  it('honours a smaller league by truncating the lineup', () => {
    const lineup = buildLineup([], index(), 3)
    expect(labels(lineup.starters)).toEqual(['QB', 'RB', 'RB'])
    expect(lineup.bench).toHaveLength(0)
  })

  it('still shows every won player when the roster is overfilled', () => {
    // Slots reduced in settings after players were already won.
    const players = [make('RB'), make('RB'), make('RB'), make('RB')]
    const lineup = buildLineup(players.map((p) => won(p, 10)), index(), 2)

    const shown = [...lineup.starters, ...lineup.bench].filter((r) => r.pick)
    expect(shown).toHaveLength(4)
  })

  it('does not place the same player in two slots', () => {
    const flexEligible = [make('RB'), make('WR'), make('TE')]
    const lineup = buildLineup(flexEligible.map((p) => won(p, 10)), index(), 16)

    const ids = [...lineup.starters, ...lineup.bench]
      .filter((r) => r.pick)
      .map((r) => r.pick!.playerId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ignores picks for players missing from the rankings', () => {
    const ghost: Pick = { playerId: 99_999, status: 'mine', price: 10, at: 0 }
    const lineup = buildLineup([ghost], index(), 16)

    // Unplaceable, but not lost — it lands on the bench rather than vanishing.
    expect(lineup.starters.every((s) => !s.pick)).toBe(true)
    expect(lineup.bench[0].pick).toEqual(ghost)
  })
})
