import { describe, it, expect } from 'vitest'
import {
  displayRoomPrice,
  inflationIsMeaningful,
  positionTier,
  roomPrice,
  summarizeMarket,
} from './market'
import { DEFAULT_SETTINGS, observedPrice, type Pick, type Player, type Settings } from './types'
import { makePlayer } from '../test/factories'

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  budget: 200,
  slots: 17,
  teamCount: 12,
  ...over,
})

/** A board of `n` players whose market values descend from `top`. */
function board(n: number, top = 60): Player[] {
  return Array.from({ length: n }, (_, i) =>
    makePlayer({
      id: i + 1,
      name: `P${i + 1}`,
      rank: i + 1,
      marketValue: Math.max(1, top - i),
      espnValue: Math.max(1, top - i),
    }),
  )
}

const picks = (entries: Pick[]) => new Map(entries.map((p) => [p.playerId, p]))
const gone = (playerId: number, price = 0): Pick => ({ playerId, status: 'gone', price, at: 0 })
const mine = (playerId: number, price: number): Pick => ({ playerId, status: 'mine', price, at: 0 })

describe('summarizeMarket', () => {
  it('reads room size from settings rather than assuming', () => {
    const m = summarizeMarket(board(10), picks([]), settings({ teamCount: 10, budget: 300, slots: 20 }))
    expect(m.roomMoney).toBe(3000)
    expect(m.roomSlots).toBe(200)
  })

  it('reports inflation above 1 when the room holds more money than the board lists', () => {
    // 12 x $200 = $2400 chasing a board listing far less.
    const m = summarizeMarket(board(204, 60), picks([]), settings())
    expect(m.moneyLeft).toBe(2400)
    expect(m.valueLeft).toBeLessThan(2400)
    expect(m.inflation).toBeGreaterThan(1)
  })

  it('counts only the players who will actually be rostered', () => {
    // 300 priced players but only 204 roster spots: the extra 96 must not
    // inflate remaining value and deflate the ratio.
    const wide = summarizeMarket(board(300, 60), picks([]), settings())
    const exact = summarizeMarket(board(204, 60), picks([]), settings())
    expect(wide.valueLeft).toBe(exact.valueLeft)
  })

  it('prices an unrecorded cross-off at the market average', () => {
    const players = board(50)
    const m = summarizeMarket(players, picks([gone(1)]), settings())
    expect(m.spent).toBe(players[0].marketValue)
    expect(m.estimated).toBe(1)
    expect(m.observed).toBe(0)
  })

  it('prefers a real observed price over the estimate', () => {
    const players = board(50)
    const m = summarizeMarket(players, picks([gone(1, 85)]), settings())
    expect(m.spent).toBe(85) // not the $60 the sheet said
    expect(m.observed).toBe(1)
    expect(m.estimated).toBe(0)
  })

  it('counts our own wins at what we actually paid', () => {
    const m = summarizeMarket(board(50), picks([mine(1, 42)]), settings())
    expect(m.spent).toBe(42)
    expect(m.observed).toBe(1)
  })

  it('consumes a room roster spot for every pick, ours or theirs', () => {
    const m = summarizeMarket(board(50), picks([gone(1), gone(2), mine(3, 10)]), settings())
    expect(m.slotsLeft).toBe(12 * 17 - 3)
  })

  it('rises as value leaves the board faster than money does', () => {
    // Everyone paying exactly sheet price still raises inflation: the surplus
    // is fixed while the value it chases keeps shrinking.
    const players = board(204, 60)
    const start = summarizeMarket(players, picks([]), settings())
    const later = summarizeMarket(
      players,
      picks(Array.from({ length: 30 }, (_, i) => gone(i + 1))),
      settings(),
    )
    expect(later.inflation).toBeGreaterThan(start.inflation)
  })

  it('falls when the room overspends early', () => {
    const players = board(204, 60)
    const atSheet = summarizeMarket(players, picks([gone(1), gone(2), gone(3)]), settings())
    const overpaid = summarizeMarket(
      players,
      picks([gone(1, 120), gone(2, 120), gone(3, 120)]),
      settings(),
    )
    expect(overpaid.inflation).toBeLessThan(atSheet.inflation)
  })

  it('never reports negative money left, even if the room somehow overspends', () => {
    const m = summarizeMarket(board(50), picks([gone(1, 99_999)]), settings())
    expect(m.moneyLeft).toBe(0)
    expect(m.spent).toBe(99_999)
  })

  it('clamps rather than reporting a wild ratio off the last few players', () => {
    const m = summarizeMarket(board(2, 1), picks([]), settings())
    expect(m.inflation).toBeLessThanOrEqual(3)
    expect(m.inflation).toBeGreaterThanOrEqual(0.5)
  })

  it('stays at 1 with an empty board rather than dividing by zero', () => {
    const m = summarizeMarket([], picks([]), settings())
    expect(m.inflation).toBe(1)
    expect(m.valueLeft).toBe(0)
  })

  it('ignores players ESPN never priced', () => {
    // Head coaches carry no market value and must not dilute the board total.
    const players = [...board(5), makePlayer({ id: 99, position: 'HC', espnValue: 0, marketValue: 0 })]
    const m = summarizeMarket(players, picks([]), settings())
    expect(m.valueLeft).toBe(summarizeMarket(board(5), picks([]), settings()).valueLeft)
  })
})

describe('the $1 floor', () => {
  it('leaves a minimum-bid player at $1 however hot the room gets', () => {
    // The failure this guards: a linear model claimed $1 filler would cost $3
    // late in a draft. You cannot bid below the minimum, and filler stays filler.
    expect(roomPrice(makePlayer({ marketValue: 1 }), 3)).toBe(1)
    expect(roomPrice(makePlayer({ marketValue: 2 }), 3)).toBe(4)
  })

  it('puts the surplus on the players people actually want', () => {
    const cheap = roomPrice(makePlayer({ marketValue: 2 }), 2)!
    const dear = roomPrice(makePlayer({ marketValue: 50 }), 2)!
    expect(cheap - 2).toBeLessThan(3)
    expect(dear - 50).toBeGreaterThan(40)
  })

  it('loses confidence once the board is down to scraps', () => {
    const scraps = summarizeMarket(board(6, 3), picks([]), settings())
    expect(scraps.confident).toBe(false)

    const full = summarizeMarket(board(204, 60), picks([]), settings())
    expect(full.confident).toBe(true)
  })
})

describe('roomPrice', () => {
  it('scales the market price by inflation', () => {
    expect(roomPrice(makePlayer({ marketValue: 40 }), 1.3)).toBe(52)
  })

  it('never drops a real player below the $1 minimum bid', () => {
    expect(roomPrice(makePlayer({ marketValue: 1 }), 0.5)).toBe(1)
  })

  it('returns nothing for a player ESPN does not price', () => {
    expect(roomPrice(makePlayer({ espnValue: 0, marketValue: 0 }), 1.3)).toBeUndefined()
  })
})

describe('observedPrice', () => {
  it('decodes the 0-means-unknown sentinel in one place', () => {
    // Three consumers used to test `price > 0` independently; the meaning of
    // the field is a fact about the log, so it lives with the log.
    expect(observedPrice(gone(1))).toBeUndefined()
    expect(observedPrice(gone(1, 85))).toBe(85)
    expect(observedPrice(mine(1, 42))).toBe(42)
  })
})

describe('displayRoomPrice', () => {
  it('says nothing when the adjusted price matches the listed one', () => {
    // Otherwise the row shows "room $40" beside "$40", which is just noise.
    expect(displayRoomPrice(makePlayer({ marketValue: 40 }), 1)).toBeUndefined()
  })

  it('reports the adjusted price when it actually differs', () => {
    expect(displayRoomPrice(makePlayer({ marketValue: 40 }), 1.3)).toBe(52)
  })

  it('says nothing for a player ESPN never priced', () => {
    expect(displayRoomPrice(makePlayer({ espnValue: 0, marketValue: 0 }), 1.3)).toBeUndefined()
  })
})

describe('confidence', () => {
  it('scales its threshold with the size of the room', () => {
    // A fixed dollar floor called the same board "rough" in a small league and
    // "solid" in a large one, for no modelled reason.
    const small = summarizeMarket(board(20, 6), picks([]), settings({ teamCount: 4, budget: 50, slots: 5 }))
    const large = summarizeMarket(board(20, 6), picks([]), settings({ teamCount: 12, budget: 200, slots: 17 }))
    expect(small.confident).toBe(true)
    expect(large.confident).toBe(false)
  })
})

describe('inflationIsMeaningful', () => {
  it('ignores drift inside the noise', () => {
    expect(inflationIsMeaningful(1.02)).toBe(false)
    expect(inflationIsMeaningful(0.98)).toBe(false)
  })

  it('flags a real deviation in either direction', () => {
    expect(inflationIsMeaningful(1.3)).toBe(true)
    expect(inflationIsMeaningful(0.8)).toBe(true)
  })
})

describe('positionTier', () => {
  /** The live 2026 WR board, market and book values as ESPN published them. */
  const WR_LADDER: [string, number][] = [
    ["Ja'Marr Chase", 58.48],
    ['Puka Nacua', 56.8],
    ['Jaxon Smith-Njigba', 55.39],
    ['Amon-Ra St. Brown', 52.57],
    ['CeeDee Lamb', 47.99],
    ['Justin Jefferson', 46.77],
    ['Drake London', 37.38],
    ['Rashee Rice', 33.35],
  ]
  const wrs = WR_LADDER.map(([name, marketValue], i) =>
    makePlayer({ id: i + 1, name, position: 'WR', marketValue, espnValue: marketValue }),
  )

  it('stops at the cliff in a real ladder', () => {
    // Steps run 97%, 97%, 95%, 91%, 97% and then fall to 80% at London. Six
    // names, and the boundary is where the board itself puts it.
    const tier = positionTier(wrs, wrs[0])
    expect(tier.map((p) => p.name)).toEqual([
      "Ja'Marr Chase",
      'Puka Nacua',
      'Jaxon Smith-Njigba',
      'Amon-Ra St. Brown',
      'CeeDee Lamb',
      'Justin Jefferson',
    ])
  })

  it('starts from the player asked about, not the top of the board', () => {
    // Below the cliff is its own tier: London and Rice keep 89% of each other.
    expect(positionTier(wrs, wrs[6]).map((p) => p.name)).toEqual(['Drake London', 'Rashee Rice'])
  })

  it('ignores other positions entirely', () => {
    // A cross-position ladder is effectively continuous, so a tier that let RBs
    // in would never find a boundary. The RB here sits mid-WR-tier by price.
    const rb = makePlayer({ id: 99, position: 'RB', marketValue: 50, espnValue: 50 })
    expect(positionTier([...wrs, rb], wrs[0])).not.toContain(rb)
  })

  it('yields just the player when nothing is close enough to be a substitute', () => {
    const alone = makePlayer({ id: 1, position: 'TE', marketValue: 40, espnValue: 40 })
    const far = makePlayer({ id: 2, position: 'TE', marketValue: 10, espnValue: 10 })
    expect(positionTier([alone, far], alone)).toEqual([alone])
  })

  it('leads with the player even when he is not on the board', () => {
    // A player already crossed off is not in `available`; asking anyway must
    // not return an empty tier the caller would have to special-case.
    const gone = makePlayer({ id: 500, position: 'WR', marketValue: 60, espnValue: 60 })
    expect(positionTier(wrs, gone)).toEqual([gone])
  })

  it('caps a long flat run rather than walking the whole board', () => {
    const flat = Array.from({ length: 40 }, (_, i) =>
      makePlayer({ id: i + 1, position: 'QB', marketValue: 30 - i * 0.1, espnValue: 30 }),
    )
    expect(positionTier(flat, flat[0])).toHaveLength(8)
  })
})
