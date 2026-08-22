import type { Pick, Player } from './types'

export interface LineupSlot {
  /** Unique within the lineup — `RB1`, `RB2`. */
  id: string
  /** What the row is labelled: two RB slots both read "RB". */
  label: string
  accepts: string[]
}

/**
 * What this league's OP ("offensive player") slot will take — any offensive
 * skill position, **including quarterback**. That makes it superflex-shaped
 * rather than a normal FLEX, which matters well beyond the label: a second
 * startable QB slot raises quarterback value sharply, and ESPN's ranks — in
 * either scoring format — assume a one-QB league, so they systematically
 * under-price QBs here.
 *
 * Exported because the board's OP filter must agree with the lineup builder —
 * one edit, not two that can silently drift apart.
 */
export const OP_POSITIONS = ['QB', 'RB', 'WR', 'TE']

/** ESPN's default starting lineup, in the order people read a roster. */
export const STARTER_SLOTS: LineupSlot[] = [
  { id: 'QB', label: 'QB', accepts: ['QB'] },
  { id: 'RB1', label: 'RB', accepts: ['RB'] },
  { id: 'RB2', label: 'RB', accepts: ['RB'] },
  { id: 'WR1', label: 'WR', accepts: ['WR'] },
  { id: 'WR2', label: 'WR', accepts: ['WR'] },
  { id: 'TE', label: 'TE', accepts: ['TE'] },
  { id: 'OP', label: 'OP', accepts: OP_POSITIONS },
  { id: 'DST', label: 'D/ST', accepts: ['D/ST'] },
  { id: 'K', label: 'K', accepts: ['K'] },
  // League-specific: a head coach slot, drafted like a D/ST (you pick a team).
  { id: 'HC', label: 'HC', accepts: ['HC'] },
]

export interface LineupRow {
  /** Stable key for React. */
  key: string
  label: string
  pick?: Pick
  player?: Player
}

export interface Lineup {
  starters: LineupRow[]
  bench: LineupRow[]
  /** Starting slots still unfilled — the number that actually matters mid-draft. */
  openStarters: number
}

/**
 * Places won players into starting slots, then the bench.
 *
 * Most expensive players get first claim, on the assumption that what you paid
 * up for is what you intend to start. Dedicated slots are filled before FLEX,
 * because a FLEX filled early can strand a dedicated slot that only one player
 * was eligible for.
 */
export function buildLineup(won: Pick[], byId: Map<number, Player>, totalSlots: number): Lineup {
  const starterDefs = STARTER_SLOTS.slice(0, Math.max(0, totalSlots))
  const benchCount = Math.max(0, totalSlots - starterDefs.length)

  const pool = [...won].sort((a, b) => b.price - a.price)
  const claimed = new Set<number>()
  const filled = new Map<string, Pick>()

  const claim = (def: LineupSlot) => {
    for (const pick of pool) {
      if (claimed.has(pick.playerId)) continue
      const position = byId.get(pick.playerId)?.position
      if (position && def.accepts.includes(position)) {
        claimed.add(pick.playerId)
        filled.set(def.id, pick)
        return
      }
    }
  }

  for (const def of starterDefs) if (def.accepts.length === 1) claim(def)
  for (const def of starterDefs) if (def.accepts.length > 1) claim(def)

  const starters: LineupRow[] = starterDefs.map((def) => {
    const pick = filled.get(def.id)
    return {
      key: def.id,
      label: def.label,
      pick,
      player: pick ? byId.get(pick.playerId) : undefined,
    }
  })

  const leftovers = pool.filter((p) => !claimed.has(p.playerId))
  const bench: LineupRow[] = leftovers.map((pick) => ({
    key: `bench-${pick.playerId}`,
    label: byId.get(pick.playerId)?.position ?? 'BE',
    pick,
    player: byId.get(pick.playerId),
  }))

  // Pad out the remaining bench spots. If we've somehow overfilled (more
  // players than slots) there's nothing left to pad and the extras still show.
  for (let i = bench.length; i < benchCount; i++) {
    bench.push({ key: `bench-open-${i}`, label: 'BE' })
  }

  return {
    starters,
    bench,
    openStarters: starters.filter((row) => !row.pick).length,
  }
}
