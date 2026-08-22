import { describe, it, expect } from 'vitest'
import { buildDraftLog } from './draftLog'
import type { Pick, Player } from './types'
import { makePlayer } from '../test/factories'

const players: Player[] = [
  makePlayer({ id: 1, name: 'Jahmyr Gibbs' }),
  makePlayer({ id: 2, name: 'Puka Nacua', position: 'WR' }),
  makePlayer({ id: 3, name: 'Josh Allen', position: 'QB' }),
]
const byId = new Map(players.map((p) => [p.id, p]))

const gone = (playerId: number, price = 0, at = playerId): Pick => ({
  playerId,
  status: 'gone',
  price,
  at,
})
const mine = (playerId: number, price: number, at = playerId): Pick => ({
  playerId,
  status: 'mine',
  price,
  at,
})

describe('buildDraftLog', () => {
  it('is empty before anyone comes off the board', () => {
    expect(buildDraftLog([], byId)).toEqual([])
  })

  it('reads most recent first, numbered from the start of the draft', () => {
    const entries = buildDraftLog([gone(1), mine(2, 40), gone(3)], byId)

    expect(entries.map((e) => e.number)).toEqual([3, 2, 1])
    expect(entries.map((e) => e.player?.name)).toEqual([
      'Josh Allen',
      'Puka Nacua',
      'Jahmyr Gibbs',
    ])
  })

  it('carries the status and what we know of the price', () => {
    const [allen, nacua, gibbs] = buildDraftLog([gone(1), mine(2, 40), gone(3, 12)], byId)

    expect(allen).toMatchObject({ status: 'gone', price: 12 })
    expect(nacua).toMatchObject({ status: 'mine', price: 40 })
    // Crossed off without a price — the log says so rather than inventing one.
    expect(gibbs).toMatchObject({ status: 'gone', price: undefined })
  })

  it('keeps a later price correction in the place the player actually went', () => {
    // Gibbs went first; his price was recorded three picks later.
    const entries = buildDraftLog([gone(1), gone(2, 9), gone(3, 12), gone(1, 55)], byId)

    expect(entries.map((e) => e.player?.name)).toEqual([
      'Josh Allen',
      'Puka Nacua',
      'Jahmyr Gibbs',
    ])
    expect(entries.map((e) => e.number)).toEqual([3, 2, 1])
    expect(entries.at(-1)).toMatchObject({ number: 1, price: 55 })
  })

  it('takes the last word on status, not the first', () => {
    // Crossed off, then re-marked as ours at the price we paid.
    const [entry] = buildDraftLog([gone(1), mine(1, 33)], byId)

    expect(entry).toMatchObject({ number: 1, status: 'mine', price: 33 })
  })

  it('numbers a player the board cannot name', () => {
    const [entry] = buildDraftLog([gone(99, 4)], byId)

    expect(entry).toMatchObject({ number: 1, playerId: 99, player: undefined, price: 4 })
  })
})
