import { wonPicksFrom, type BudgetSummary } from './budget'
import { buildLineup, STARTER_SLOTS } from './lineup'
import {
  availablePlayers,
  inflationIsMeaningful,
  positionTier,
  roomPrice,
  type MarketState,
} from './market'
import {
  marketIsComparable,
  marketPremium,
  priceAnchor,
  type Pick,
  type Player,
  type Settings,
} from './types'

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
export type Posture = 'drain' | 'buy'

/** Why we're in the posture we're in. Each of these comes with a suggestion. */
export type MoveReason =
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

/**
 * The posture is a total function of the reason, so it is derived rather than
 * carried alongside it — two fields that can disagree is one more thing to
 * keep in step every time a reason is added.
 */
export function postureFor(reason: MoveReason): Posture {
  return reason === 'rich' ? 'drain' : 'buy'
}

export interface NominationPick {
  player: Player
  /** What to open the bidding at. */
  openAt: number
  /** What this player is likely to actually go for in this room. */
  expected: number
  /** True when the player would fill a starting slot we still have open. */
  fillsNeed: boolean
  /**
   * Room price over ESPN's book value — the size of the overpay we're handing
   * off. Undefined under SUPERFLEX, where book and market aren't quoted in the
   * same format and subtracting one from the other means nothing; see
   * `marketIsComparable`. The banner drops the claim rather than printing a
   * number built out of two different games.
   */
  premium?: number
}

interface AdviceBase {
  /**
   * What one *typical* rival team can still bid, estimated from the money and
   * roster spots left across the room. The comparison against our own ceiling
   * is what flips drain into buy, so it is the number worth showing.
   */
  rivalMaxBid: number
  /** Our ceiling, carried through so the banner needn't re-derive it. */
  maxBid: number
}

/** There is a board, but nothing on it we can bid on. Worth saying; no move. */
export interface IdleAdvice extends AdviceBase {
  kind: 'idle'
}

export interface MoveAdvice extends AdviceBase {
  kind: 'move'
  reason: MoveReason
  pick: NominationPick
}

/**
 * `null` means "not worth a phone screen's height" — no board yet, or a full
 * roster, which the budget bar already announces. Saying it here rather than
 * letting the banner branch on a reason string keeps the silent/spoken call
 * in one place, where a new reason has to face it.
 */
export type NominationAdvice = IdleAdvice | MoveAdvice

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
}: NominationInput): NominationAdvice | null {
  // No board yet is not the same as an exhausted one, and neither is worth a
  // banner: the first has nothing to say, the second is already on the header.
  if (players.length === 0 || summary.rosterFull) return null

  const base: AdviceBase = { rivalMaxBid: typicalRivalMaxBid(summary, settings, market), maxBid: summary.maxBid }
  const needed = openStarterPositions(wonPicksFrom(picks), players, settings.slots)
  const available = availablePlayers(players, picks)

  const reason = decideReason(summary, market, base.rivalMaxBid)
  const pick =
    postureFor(reason) === 'drain'
      ? drainPick(available, needed, settings, market)
      : buyPick(available, needed, settings, summary, market)

  // Nothing we can bid on is itself the answer, not a missing one.
  if (!pick) return { ...base, kind: 'idle' }
  return { ...base, kind: 'move', reason, pick }
}

/**
 * The posture decision, in priority order. Read top to bottom: each rule wins
 * over the ones below it because it describes a more urgent fact about the room.
 */
function decideReason(
  summary: BudgetSummary,
  market: MarketState,
  rivalMaxBid: number,
): MoveReason {
  // A last slot spent on a drain nomination that stuck would end the draft on a
  // player we never wanted. Never risk it for a strategic gain we can't cash.
  if (summary.slotsLeft <= 1) return 'lastSlot'
  // Rivals reduced to the $1 minimum cannot contest anything. Stop manoeuvring.
  if (rivalMaxBid <= 1) return 'endgame'
  if (summary.maxBid < rivalMaxBid * BEHIND_MARGIN) return 'behind'
  // Par inflation means the money has drained out of the room on its own.
  // Feeding it more players now donates value to whoever is left holding cash.
  if (market.inflation <= 1 || !inflationIsMeaningful(market.inflation)) return 'bargains'
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
function openStarterPositions(won: Pick[], players: Player[], slots: number): Set<string> {
  // Only won picks are ever looked up, so the map is built from those rather
  // than from the whole board.
  const byId = new Map<number, Player>()
  for (const pick of won) {
    const player = players.find((p) => p.id === pick.playerId)
    if (player) byId.set(pick.playerId, player)
  }

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
 * Narrow to the players we'd rather have, but never to none of them: an empty
 * result means the preference could not be honoured, not that there is nothing
 * to nominate. Written once because all three narrowings below want it.
 */
function prefer(players: Player[], keep: (p: Player) => boolean): Player[] {
  const kept = players.filter(keep)
  return kept.length > 0 ? kept : players
}

/**
 * Injured players make poor suggestions in both modes: as a drain they may not
 * draw the bids that make the strategy work, and as a buy the banner would be
 * pushing a risk the user hasn't opened the row to see.
 */
const preferHealthy = (players: Player[]) => prefer(players, (p) => !p.injured)

/**
 * Most expensive first, by the number this format actually prices players in —
 * see `priceAnchor`. Sorting the market column here would have put a $65
 * running back ahead of a $59 quarterback in a league that starts two of them.
 */
const byValueDesc = (scoring: Settings['scoring']) => (a: Player, b: Player) =>
  priceAnchor(b, scoring) - priceAnchor(a, scoring)

/**
 * Drain: an expensive player we don't need, ideally one the room is already
 * paying over book for. The premium is the point — it is someone else's money
 * being wasted, and we would rather it were wasted than aimed at our targets.
 *
 * The pool is one nomination round deep, which is what `teamCount` means: the
 * players actually in play before it is our turn again. Anyone deeper moves
 * too little money to be worth a turn.
 */
function drainPick(
  available: Player[],
  needed: Set<string>,
  settings: Settings,
  market: MarketState,
): NominationPick | undefined {
  const round = Math.max(1, settings.teamCount)
  const pool = preferHealthy([...available].sort(byValueDesc(settings.scoring)).slice(0, round))
  const candidates = prefer(pool, (p) => !needed.has(p.position))

  // With no premium signal (SUPERFLEX) this collapses to the tiebreak, which
  // is the right degradation: absent a known overpay, the most expensive body
  // we don't need is still the one that moves the most money out of the room.
  const player = candidates.sort(
    (a, b) =>
      (marketPremium(b, settings.scoring) ?? 0) - (marketPremium(a, settings.scoring) ?? 0) ||
      b.marketValue - a.marketValue,
  )[0]
  return player && toPick(player, needed, settings, market, 'drain')
}

/**
 * Buy: the best player we can afford who fills a hole, then the tail of his
 * tier — the near-identical player the room has priced lower because his name
 * sits further down the sheet.
 */
function buyPick(
  available: Player[],
  needed: Set<string>,
  settings: Settings,
  summary: BudgetSummary,
  market: MarketState,
): NominationPick | undefined {
  const affordable = available.filter((p) => {
    const price = roomPrice(p, market.inflation, settings.scoring)
    return price !== undefined && price <= summary.maxBid
  })
  if (affordable.length === 0) return undefined

  const pool = preferHealthy(prefer(affordable, (p) => needed.has(p.position)))
  const leader = [...pool].sort(byValueDesc(settings.scoring))[0]

  // The premium is what finds the tail of the tier. Without it (SUPERFLEX) the
  // tiebreak has to carry the intent on its own, and the intent is *cheapest*
  // near-identical player — so the fallback sorts up, not down. Leaving the
  // descending tiebreak in place would have handed back the tier leader, i.e.
  // exactly the player this function exists to avoid nominating.
  const tier = positionTier(pool, leader, settings.scoring)
  const player = marketIsComparable(settings.scoring)
    ? [...tier].sort(
        (a, b) =>
          (marketPremium(a, settings.scoring) ?? 0) - (marketPremium(b, settings.scoring) ?? 0) ||
          b.marketValue - a.marketValue,
      )[0]
    : [...tier].sort((a, b) => a.marketValue - b.marketValue)[0]
  return player && toPick(player, needed, settings, market, 'buy')
}

function toPick(
  player: Player,
  needed: Set<string>,
  settings: Settings,
  market: MarketState,
  posture: Posture,
): NominationPick {
  const expected =
    roomPrice(player, market.inflation, settings.scoring) ??
    Math.round(priceAnchor(player, settings.scoring))
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
    fillsNeed: needed.has(player.position),
    premium: marketPremium(player, settings.scoring),
  }
}
