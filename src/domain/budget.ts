import type { DraftState, Pick } from './types'

export interface BudgetSummary {
  /** Dollars not yet spent. */
  remaining: number
  /** Roster spots still to fill. */
  slotsLeft: number
  /**
   * The most we can bid on the player in front of us while still being able to
   * pay the $1 minimum for every other slot we have left to fill.
   */
  maxBid: number
  /** Pacing signal: what we can average on each remaining slot. */
  avgPerSlot: number
  spent: number
  filled: number
  rosterFull: boolean
}

/** Collapse the append-only log into the current pick per player. */
export function picksByPlayer(state: DraftState): Map<number, Pick> {
  const map = new Map<number, Pick>()
  for (const pick of state.log) map.set(pick.playerId, pick)
  return map
}

/**
 * The single definition of "a pick we won". The budget bar and the lineup must
 * never disagree about this, so both go through here.
 */
export function wonPicksFrom(picks: Map<number, Pick>): Pick[] {
  return [...picks.values()].filter((p) => p.status === 'mine')
}

export function wonPicks(state: DraftState): Pick[] {
  return wonPicksFrom(picksByPlayer(state))
}

export function summarize(state: DraftState): BudgetSummary {
  const won = wonPicks(state)
  const spent = won.reduce((sum, p) => sum + p.price, 0)
  const filled = won.length

  const remaining = state.settings.budget - spent
  const slotsLeft = Math.max(0, state.settings.slots - filled)

  // Every *other* open slot needs at least $1 held back for it. With one slot
  // left there is nothing to reserve, so the whole remainder is bid-able.
  const maxBid = slotsLeft <= 0 ? 0 : Math.max(0, remaining - (slotsLeft - 1))

  return {
    remaining,
    slotsLeft,
    maxBid,
    avgPerSlot: slotsLeft > 0 ? remaining / slotsLeft : 0,
    spent,
    filled,
    rosterFull: slotsLeft === 0,
  }
}

/**
 * Whether a bid is legal given current state. Bids are whole dollars and the
 * league minimum is $1.
 */
export function canBid(state: DraftState, price: number): boolean {
  if (!Number.isInteger(price) || price < 1) return false
  return price <= summarize(state).maxBid
}

/** What the budget looks like *after* a hypothetical win — for confirm screens. */
export function previewBid(state: DraftState, playerId: number, price: number): BudgetSummary {
  const pick: Pick = { playerId, status: 'mine', price, at: Date.now() }
  return summarize({ ...state, log: [...state.log, pick] })
}
