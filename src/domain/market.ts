import {
  isUnpriced,
  marketIsComparable,
  observedPrice,
  priceAnchor,
  type Pick,
  type Player,
  type Scoring,
  type Settings,
} from './types'

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

/**
 * Still on the board and carrying a price.
 *
 * Both halves matter and they travel together: a player who is gone can't be
 * bought, and an unpriced one (every head coach, the deepest bench) can't be
 * reasoned about in dollars. Shared so that whatever reads the inflation
 * figure is ranging over the same pool that produced it — advice derived from
 * a different set than the number it quotes would be quietly incoherent.
 */
export function availablePlayers(players: Player[], picks: Map<number, Pick>): Player[] {
  return players.filter((p) => !picks.has(p.id) && !isUnpriced(p))
}

/**
 * A tier ends where the price ladder falls off a cliff, and this is how big a
 * step counts as one: the next player keeping less than 88% of the last.
 *
 * Measured against a live top-200 board rather than guessed. Two findings set
 * this, and the first is the load-bearing one:
 *
 * **Tiers are positional.** Down the *cross-position* price ladder the median
 * step keeps 97.8% and even the 5th percentile keeps 87.5% — with every
 * position interleaved the ladder is effectively continuous, and walking it
 * for a cliff runs 64 players deep and finds nothing meaningful. Inside a
 * single position the structure is real and obvious: the 2026 WR ladder runs
 * 97%, 98%, 95%, 91%, 97% and then drops to 80%. That 80% is a tier boundary
 * you can see from across the room; nothing cross-position looks like it.
 *
 * **88% clears the noise.** It sits above the observed within-position breaks
 * (80% at WR, 83% at RB) and below the ordinary step, so it cuts at cliffs and
 * nowhere else.
 */
const TIER_CLIFF = 0.88

/**
 * A backstop on how far the cliff walk may run, not the definition of a tier.
 * The walk normally stops on its own; this only bounds the degenerate case of
 * a long flat run of near-identical prices deep in the board.
 */
const TIER_DEPTH = 8

/**
 * The run of players who are substitutes for `from`: same position, walking
 * his price ladder downward until it falls off a cliff.
 *
 * This is a fact about the board rather than about any one feature, and it
 * lives here for the same reason `displayRoomPrice` does — the row, the bid
 * sheet and the nomination banner must not each grow their own idea of who
 * counts as the same player with a cheaper name. `from` always leads the
 * result, so a board with no tier on it yields just him.
 */
export function positionTier(available: Player[], from: Player, scoring: Scoring): Player[] {
  const ladder = available
    .filter((p) => p.position === from.position)
    .sort((a, b) => priceAnchor(b, scoring) - priceAnchor(a, scoring))

  const start = ladder.findIndex((p) => p.id === from.id)
  if (start < 0) return [from]

  const tier = [ladder[start]]
  for (let i = start; i + 1 < ladder.length && tier.length < TIER_DEPTH; i++) {
    if (priceAnchor(ladder[i + 1], scoring) < priceAnchor(ladder[i], scoring) * TIER_CLIFF) break
    tier.push(ladder[i + 1])
  }
  return tier
}

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
      // The anchor, not the market column: a quarterback who went for real
      // money while we were not watching would otherwise be booked at his
      // one-QB average, leaving the room holding cash it has already spent.
      const p = byId.get(pick.playerId)
      spent += p ? priceAnchor(p, settings.scoring) : 0
      estimated++
    }
  }

  const moneyLeft = Math.max(0, roomMoney - spent)
  const slotsLeft = Math.max(0, roomSlots - picks.size)

  // Only the players who will actually be rostered count toward remaining
  // value. Summing the whole board would count hundreds of players nobody
  // drafts and understate inflation badly.
  const available = availablePlayers(players, picks)
    .sort((a, b) => priceAnchor(b, settings.scoring) - priceAnchor(a, settings.scoring))
    .slice(0, slotsLeft)
  const valueLeft = available.reduce((sum, p) => sum + priceAnchor(p, settings.scoring), 0)

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
  const discretionaryValue = available.reduce(
    (sum, p) => sum + Math.max(0, priceAnchor(p, settings.scoring) - 1),
    0,
  )

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
export function roomPrice(player: Player, inflation: number, scoring: Scoring): number | undefined {
  if (isUnpriced(player)) return undefined
  // Only the amount above the $1 minimum inflates.
  return Math.max(1, Math.round(1 + (priceAnchor(player, scoring) - 1) * inflation))
}

/**
 * The room price, but only when it differs from the listed one as displayed.
 * The rule lives here so the row, the bid sheet and the header cannot disagree
 * about when an adjustment is worth showing.
 */
export function displayRoomPrice(
  player: Player,
  inflation: number,
  scoring: Scoring,
): number | undefined {
  const room = roomPrice(player, inflation, scoring)
  // Compared against the number it was derived from, which is the anchor and
  // not always the market column. Suppressing on a match with a figure that
  // never fed the calculation would hide the adjustment at random prices.
  if (room === undefined || room === Math.round(priceAnchor(player, scoring))) return undefined
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

/**
 * How the market column actually reads against the book, at one position, on
 * the board we are holding — as a percentage. 23 means the market average is
 * running at roughly a quarter of ESPN's book value for that position.
 *
 * This exists because the caveat needs a number and a constant would rot. The
 * app runs once a year; a "market reads ~23% of book at QB" baked into the
 * source in one August is a confident lie by the next, and nothing in the UI
 * would say so. Measured off the loaded board it is simply always current, and
 * it costs a median over a few dozen rows on a screen that opens by hand.
 *
 * Only meaningful where the two columns disagree by format — see
 * `marketIsComparable`. Under a one-QB book this is the ordinary
 * market-over-book premium, which `marketPremium` already says better, per
 * player, so it returns undefined rather than inviting a second reading of the
 * same thing.
 *
 * Undefined below `GAP_MIN_SAMPLE` priced players too. A median over three
 * rows is a number with no claim on the board, and this one is printed as a
 * fact about the format.
 */
export function marketVsBookPct(
  players: Player[],
  scoring: Scoring,
  position: string,
): number | undefined {
  if (marketIsComparable(scoring)) return undefined

  const ratios = players
    .filter((p) => p.position === position && !isUnpriced(p) && p.espnValue > 0 && p.marketValue > 0)
    .map((p) => p.marketValue / p.espnValue)
    .sort((a, b) => a - b)

  if (ratios.length < GAP_MIN_SAMPLE) return undefined

  // Median, not mean: one $1 quarterback whose book value is $30 drags an
  // average further than he tells us anything, and the deep end of every
  // position is full of them.
  const mid = Math.floor(ratios.length / 2)
  const median =
    ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid]

  return Math.round(median * 100)
}

/** Below this a median says more about the sample than about the board. */
export const GAP_MIN_SAMPLE = 5
