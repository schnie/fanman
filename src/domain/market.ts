import { isUnpriced, observedPrice, type Pick, type Player, type Settings } from './types'

/**
 * Auction inflation: how much real money is chasing each dollar of listed
 * value, right now, in this specific room.
 *
 * Every dollar in an auction gets spent — the room must fill every roster spot
 * — so the money left is by definition the true price of the players left. If
 * that money exceeds their listed value, everything remaining costs more than
 * the sheet says, and bidding the sheet means finishing with cash you never
 * used. Which in an auction is just wasted roster.
 *
 * This is not a small correction. With ESPN's 2026 values, 12 teams at $200
 * start at roughly 1.30x before a single pick.
 */
export interface MarketState {
  /** Total dollars in the room across all teams. */
  roomMoney: number
  /** Total roster spots across all teams. */
  roomSlots: number
  /** Dollars believed spent so far, ours known exactly and others estimated. */
  spent: number
  moneyLeft: number
  /** Roster spots still open across the whole room. */
  slotsLeft: number
  /** Listed value of the players expected to fill those spots. */
  valueLeft: number
  /**
   * Multiplier on the *discretionary* part of a price — the part above the $1
   * minimum. See the note on the $1 floor below.
   */
  inflation: number
  /**
   * False once so little listed value remains that the ratio is being driven
   * by a handful of near-worthless players. The number is still shown, but the
   * UI should stop presenting it as precise.
   */
  confident: boolean
  /** Cross-offs where we recorded the real price. */
  observed: number
  /** Cross-offs priced from the market average because nobody typed one in. */
  estimated: number
}

/**
 * Inflation is a ratio of two shrinking numbers, so it gets noisy once the
 * board is nearly exhausted — a couple of mispriced stragglers can swing it
 * wildly. Clamp to a range that stays useful rather than showing nonsense.
 */
const MIN_INFLATION = 0.5
const MAX_INFLATION = 3

/**
 * Below this share of the room's total money still on the board, the ratio is
 * being driven by scraps. Expressed as a fraction so it scales with league
 * size rather than meaning something different in a $1000 room than a $2400 one.
 */
const CONFIDENCE_FLOOR_FRACTION = 0.025

export function summarizeMarket(
  players: Player[],
  picks: Map<number, Pick>,
  settings: Settings,
): MarketState {
  const roomMoney = settings.teamCount * settings.budget
  const roomSlots = settings.teamCount * settings.slots

  const byId = new Map(players.map((p) => [p.id, p]))
  let spent = 0
  let observed = 0
  let estimated = 0

  for (const pick of picks.values()) {
    if (pick.status === 'mine') {
      spent += pick.price
      observed++
      continue
    }
    // A cross-off with a price is something we watched sell. Without one, the
    // market average is the best available guess and is right on average.
    const seen = observedPrice(pick)
    if (seen !== undefined) {
      spent += seen
      observed++
    } else {
      spent += byId.get(pick.playerId)?.marketValue ?? 0
      estimated++
    }
  }

  const moneyLeft = Math.max(0, roomMoney - spent)
  const slotsLeft = Math.max(0, roomSlots - picks.size)

  // Only the players who will actually be rostered count toward remaining
  // value. Summing the whole board would count hundreds of players nobody
  // drafts and understate inflation badly.
  const available = players
    .filter((p) => !picks.has(p.id) && !isUnpriced(p))
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, slotsLeft)
  const valueLeft = available.reduce((sum, p) => sum + p.marketValue, 0)

  /**
   * The $1 floor. Every open roster spot must be filled and no bid can be
   * under a dollar, so that money is committed and cannot inflate anything.
   * Only the surplus above it chases the surplus value above it.
   *
   * Without this the model claims a $1 filler player will cost $3 late in a
   * draft, which is not a thing that happens — you cannot bid below the
   * minimum, and true filler stays filler. Applying inflation only to the part
   * of a price above $1 keeps cheap players cheap and puts the surplus where
   * it actually goes: on the players people still want.
   */
  const discretionaryMoney = Math.max(0, moneyLeft - slotsLeft)
  const discretionaryValue = available.reduce((sum, p) => sum + Math.max(0, p.marketValue - 1), 0)

  const raw = discretionaryValue > 0 ? discretionaryMoney / discretionaryValue : 1
  const inflation = clamp(raw, MIN_INFLATION, MAX_INFLATION)

  return {
    roomMoney,
    roomSlots,
    spent,
    moneyLeft,
    slotsLeft,
    valueLeft,
    inflation,
    confident: discretionaryValue >= roomMoney * CONFIDENCE_FLOOR_FRACTION,
    observed,
    estimated,
  }
}

/**
 * What a player is likely to actually cost in this room, as opposed to what
 * the sheet says. Undefined for anything ESPN doesn't price — we won't invent
 * a market number on top of a missing one.
 */
export function roomPrice(player: Player, inflation: number): number | undefined {
  if (isUnpriced(player)) return undefined
  // Only the amount above the $1 minimum inflates.
  return Math.max(1, Math.round(1 + (player.marketValue - 1) * inflation))
}

/**
 * The room price, but only when it differs from the listed one as displayed.
 * The rule lives here so the row, the bid sheet and the header cannot disagree
 * about when an adjustment is worth showing.
 */
export function displayRoomPrice(player: Player, inflation: number): number | undefined {
  const room = roomPrice(player, inflation)
  if (room === undefined || room === Math.round(player.marketValue)) return undefined
  return room
}

/** Below this the adjustment is inside the noise and not worth showing. */
export const INFLATION_DISPLAY_THRESHOLD = 0.05

export function inflationIsMeaningful(inflation: number): boolean {
  return Math.abs(inflation - 1) >= INFLATION_DISPLAY_THRESHOLD
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
