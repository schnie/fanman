import { observedPrice, type Pick, type PickStatus, type Player } from './types'

/**
 * One player coming off the board, as the log reads it back.
 *
 * `player` is optional for the same reason the roster prints `Player 4211`:
 * the draft outlives any particular board, so a log restored beside rankings
 * that failed to fetch — or that came back under a different scoring type —
 * can hold ids nothing on screen can name. Better a numbered row we can't
 * label than a gap in the sequence.
 */
export interface DraftLogEntry {
  /** 1-based, counting from the first player crossed off. */
  number: number
  playerId: number
  player: Player | undefined
  status: PickStatus
  /** What we watched it sell for, or undefined when nobody caught the price. */
  price: number | undefined
}

/**
 * The draft as it happened: every player crossed off, in the order they went,
 * most recent first.
 *
 * Two things this has to get right that a `map` over the log would not.
 *
 * A player can appear in the log more than once — recording a sale price after
 * the fact appends a second entry rather than editing the first, which is what
 * keeps the log append-only and undo a pop. So entries are collapsed per
 * player: the *first* mention fixes where they sit in the order, because that
 * is when the room actually took them, and the *last* one supplies the status
 * and price, because that is the correction. Ordering by the correction would
 * teleport a player twenty picks forward for the crime of having their price
 * filled in late.
 *
 * And the numbering counts from the start of the draft while the list reads
 * from the end of it, so `number` is assigned before the reversal. Numbering a
 * reversed list would renumber every row on every pick.
 */
export function buildDraftLog(log: Pick[], byId: Map<number, Player>): DraftLogEntry[] {
  const order: number[] = []
  const latest = new Map<number, Pick>()

  for (const pick of log) {
    if (!latest.has(pick.playerId)) order.push(pick.playerId)
    latest.set(pick.playerId, pick)
  }

  return order
    .map((playerId, i) => {
      const pick = latest.get(playerId)!
      return {
        number: i + 1,
        playerId,
        player: byId.get(playerId),
        status: pick.status,
        price: observedPrice(pick),
      }
    })
    .reverse()
}
