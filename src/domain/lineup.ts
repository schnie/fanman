import type { Pick, Player, Settings } from './types'

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
 * startable QB slot raises quarterback value sharply, which is why the board
 * is fetched from ESPN's SUPERFLEX rank book rather than a one-QB one.
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

/**
 * True when the starting lineup can field a second quarterback — which is the
 * whole reason this league reads ESPN's SUPERFLEX book rather than a one-QB
 * one. Derived from `accepts` rather than from the `OP` label, so a lineup
 * that renames the slot still answers correctly.
 *
 * Takes `slots` because a short roster truncates `STARTER_SLOTS`: with fewer
 * than seven starters the OP slot isn't in the lineup at all, and then the
 * league genuinely is a one-QB one.
 */
export function lineupIsSuperflex(slots: number): boolean {
  return STARTER_SLOTS.slice(0, Math.max(0, slots)).some(
    (slot) => slot.id !== 'QB' && slot.accepts.includes('QB'),
  )
}

/**
 * The board is priced from a book that does not match the lineup.
 *
 * This is reachable by design, not by accident: `migrateSettings` deliberately
 * refuses to switch books mid-draft, because doing so drops the cached board
 * and betting on venue wifi in the middle of an auction is the one thing this
 * app is built not to do. The cost of that choice is a draft that runs on
 * one-QB values while every other part of the app looks correct, and the
 * symptom — quarterbacks priced at a fraction of their worth — reads as an
 * ESPN problem rather than as a setting. So it has to be said out loud.
 */
export function bookMismatch(settings: Settings): boolean {
  return lineupIsSuperflex(settings.slots) && settings.scoring !== 'SUPERFLEX'
}

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
