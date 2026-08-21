import type { BudgetSummary } from './budget'
import { buildLineup, STARTER_SLOTS } from './lineup'
import { inflationIsMeaningful, roomPrice, type MarketState } from './market'
import { isUnpriced, marketPremium, type Pick, type Player, type Settings } from './types'

/**
 * What to throw out next, and why.
 *
 * Nominating is not picking. You almost never win the player you put up, so a
 * nomination is judged by what it does to the *other* wallets in the room:
 * every dollar someone else spends on a player you didn't want is a dollar
 * that cannot bid against you later. That gives two opposite modes, and the
 * whole job of this module is deciding which one we're in.
 *
 *   drain — we hold more money than the field and the board is still
 *           over-priced, so we feed the room players we don't need and let
 *           them pay up.
 *   buy   — we're behind on money, or the room has spent itself out and
 *           bargains have appeared. Draining now would hand value away; put
 *           our own targets up instead.
 *
 * Everything here is aggregate. The draft log records what *we* won and that
 * players are gone, never which rival bought them, so this can talk about a
 * "typical rival" and never about a specific team. The UI must not present
 * these as per-team facts.
 */
export type Posture = 'drain' | 'buy' | 'idle'

export type NominationReason =
  /** Ahead of the field, and the sheet still under-prices this room. */
  | 'rich'
  /** The typical rival outguns us — every round we wait, our targets drift further away. */
  | 'behind'
  /** Inflation is back to par: the room is running dry and value has appeared. */
  | 'bargains'
  /** Rivals are down to $1 bids. Anything we want is nearly uncontested. */
  | 'endgame'
  /** One slot left. It has to be someone we actually want. */
  | 'lastSlot'
  | 'rosterFull'
  /** Nothing left on the board worth suggesting. */
  | 'noBoard'

export interface NominationPick {
  player: Player
  /** What to open the bidding at. */
  openAt: number
  /** What this player is likely to actually go for in this room. */
  expected: number
  /** How far under the expected sale price the opening bid sits. */
  cushion: number
  /** True when the player would fill a starting slot we still have open. */
  fillsNeed: boolean
  /** Room price over ESPN's book value — the size of the overpay we're handing off. */
  premium: number
}

export interface NominationAdvice {
  posture: Posture
  reason: NominationReason
  /**
   * What one *typical* rival team can still bid, estimated from the money and
   * roster spots left across the room. The comparison against our own ceiling
   * is what flips drain into buy, so it is the number worth showing.
   */
  rivalMaxBid: number
  /** Our ceiling, carried through so the banner needn't re-derive it. */
  maxBid: number
  pick?: NominationPick
}

export interface NominationInput {
  players: Player[]
  picks: Map<number, Pick>
  summary: BudgetSummary
  settings: Settings
  market: MarketState
}

/**
 * How far behind the typical rival we tolerate before we stop draining. Some
 * gap is normal noise in an estimate built from room averages; a tenth of the
 * field's ceiling is the point where waiting genuinely costs us targets.
 */
const BEHIND_MARGIN = 0.9

/**
 * Roughly one nomination round in a twelve-team league — the players actually
 * in play right now. Draining with anyone deeper than this moves too little
 * money to be worth a turn.
 */
const DRAIN_POOL = 12

/**
 * The tail of a tier. Rooms price by name rather than by cliff, so the fifth
 * player in a group of near-identical ones routinely sells for meaningfully
 * less than the first. When we're buying, that tail is where the value is.
 */
const TIER_DEPTH = 5

/**
 * Where to open a drain nomination, as a share of the expected sale price.
 *
 * Low enough that someone will always take it off our hands — the one way this
 * strategy backfires is getting stuck — and high enough to skip the $1-at-a-
 * time crawl that wastes the room's patience. It also makes being stuck a good
 * outcome rather than a bad one: at 60% of the room price, a nomination that
 * comes back to us is a player bought well under market.
 */
const DRAIN_OPEN_SHARE = 0.6

export function suggestNomination({
  players,
  picks,
  summary,
  settings,
  market,
}: NominationInput): NominationAdvice {
  const rivalMaxBid = typicalRivalMaxBid(summary, settings, market)
  const base = { rivalMaxBid, maxBid: summary.maxBid }

  if (summary.rosterFull) return { ...base, posture: 'idle', reason: 'rosterFull' }

  const byId = new Map(players.map((p) => [p.id, p]))
  const won = [...picks.values()].filter((p) => p.status === 'mine')
  const needed = openStarterPositions(won, byId, settings.slots)

  // Unpriced players (head coaches, the deepest bench) are excluded rather than
  // given an invented price: a nomination banner quoting a number ESPN never
  // published would be exactly the thing the rest of the app refuses to do.
  const available = players.filter((p) => !picks.has(p.id) && !isUnpriced(p))
  if (available.length === 0) return { ...base, posture: 'idle', reason: 'noBoard' }

  const reason = decideReason(summary, market, rivalMaxBid)
  const posture: Posture = reason === 'rich' ? 'drain' : 'buy'
  const pick =
    posture === 'drain'
      ? drainPick(available, needed, market)
      : buyPick(available, needed, summary, market)

  // Nothing affordable is itself the answer, not a missing one: with no pick
  // the banner drops to the posture line rather than inventing a suggestion.
  if (!pick) return { ...base, posture: 'idle', reason: 'noBoard' }
  return { ...base, posture, reason, pick }
}

/**
 * The posture decision, in priority order. Read top to bottom: each rule wins
 * over the ones below it because it describes a more urgent fact about the room.
 */
function decideReason(
  summary: BudgetSummary,
  market: MarketState,
  rivalMaxBid: number,
): NominationReason {
  // A last slot spent on a drain nomination that stuck would end the draft on a
  // player we never wanted. Never risk it for a strategic gain we can't cash.
  if (summary.slotsLeft <= 1) return 'lastSlot'
  // Rivals reduced to the $1 minimum cannot contest anything. Stop manoeuvring.
  if (rivalMaxBid <= 1) return 'endgame'
  if (summary.maxBid < rivalMaxBid * BEHIND_MARGIN) return 'behind'
  // Par inflation means the money has drained out of the room on its own.
  // Feeding it more players now donates value to whoever is left holding cash.
  if (!(inflationIsMeaningful(market.inflation) && market.inflation > 1)) return 'bargains'
  return 'rich'
}

/**
 * What one typical rival can still bid.
 *
 * We know the room's total money and slots, and our own exactly, so the rest
 * divided by the other teams is the best available read on the field. It is an
 * average: one rival may be sitting on far more. Treated as a signal for which
 * way to lean, never as a bidding ceiling to plan against.
 */
function typicalRivalMaxBid(
  summary: BudgetSummary,
  settings: Settings,
  market: MarketState,
): number {
  const rivals = settings.teamCount - 1
  if (rivals <= 0) return 0

  const money = Math.max(0, market.moneyLeft - summary.remaining)
  const slots = Math.max(0, market.slotsLeft - summary.slotsLeft)
  const perTeamSlots = slots / rivals
  if (perTeamSlots <= 0) return 0

  // Same shape as our own max bid: hold back $1 for every *other* open slot.
  const reserve = Math.max(0, perTeamSlots - 1)
  return Math.max(0, Math.floor(money / rivals - reserve))
}

/** Positions that would fill a starting slot we still have open. */
function openStarterPositions(
  won: Pick[],
  byId: Map<number, Player>,
  slots: number,
): Set<string> {
  const defs = new Map(STARTER_SLOTS.map((d) => [d.id, d]))
  const lineup = buildLineup(won, byId, slots)
  const needed = new Set<string>()
  for (const row of lineup.starters) {
    if (row.pick) continue
    for (const position of defs.get(row.key)?.accepts ?? []) needed.add(position)
  }
  return needed
}

/**
 * Injured players make poor suggestions in both modes: as a drain they may not
 * draw the bids that make the strategy work, and as a buy the banner would be
 * pushing a risk the user hasn't opened the row to see. Only fall back to them
 * when the board offers nothing else.
 */
function preferHealthy(players: Player[]): Player[] {
  const healthy = players.filter((p) => !p.injured)
  return healthy.length > 0 ? healthy : players
}

const byValueDesc = (a: Player, b: Player) => b.marketValue - a.marketValue

/**
 * Drain: an expensive player we don't need, ideally one the room is already
 * paying over book for. The premium is the point — it is someone else's money
 * being wasted, and we would rather it were wasted than aimed at our targets.
 */
function drainPick(
  available: Player[],
  needed: Set<string>,
  market: MarketState,
): NominationPick | undefined {
  const pool = preferHealthy([...available].sort(byValueDesc).slice(0, DRAIN_POOL))
  const spare = pool.filter((p) => !needed.has(p.position))
  const candidates = spare.length > 0 ? spare : pool

  const player = [...candidates].sort(
    (a, b) => marketPremium(b) - marketPremium(a) || b.marketValue - a.marketValue,
  )[0]
  return player && toPick(player, needed, market, 'drain')
}

/**
 * Buy: the best player we can actually afford who fills a hole, favouring the
 * tail of his tier — the near-identical player the room has priced lower
 * because his name sits further down the sheet.
 */
function buyPick(
  available: Player[],
  needed: Set<string>,
  summary: BudgetSummary,
  market: MarketState,
): NominationPick | undefined {
  const affordable = available.filter((p) => {
    const price = roomPrice(p, market.inflation)
    return price !== undefined && price <= summary.maxBid
  })
  if (affordable.length === 0) return undefined

  const wanted = affordable.filter((p) => needed.has(p.position))
  const pool = preferHealthy(wanted.length > 0 ? wanted : affordable)
  const tier = [...pool].sort(byValueDesc).slice(0, TIER_DEPTH)

  const player = [...tier].sort(
    (a, b) => marketPremium(a) - marketPremium(b) || b.marketValue - a.marketValue,
  )[0]
  return player && toPick(player, needed, market, 'buy')
}

function toPick(
  player: Player,
  needed: Set<string>,
  market: MarketState,
  posture: Exclude<Posture, 'idle'>,
): NominationPick {
  const expected = roomPrice(player, market.inflation) ?? Math.round(player.marketValue)
  // Opening at $1 when we want the player: there is never a reason to bid
  // against ourselves, and against a drained room it sometimes simply wins.
  const openAt =
    posture === 'buy'
      ? 1
      : Math.max(1, Math.min(expected - 1, Math.round(expected * DRAIN_OPEN_SHARE)))

  return {
    player,
    openAt,
    expected,
    cushion: expected - openAt,
    fillsNeed: needed.has(player.position),
    premium: marketPremium(player),
  }
}
