import { buildLineup } from './lineup'
import type { Pick, Player } from './types'

/** What one bye week costs us: who's out, and whether we can still field a team. */
export interface ByeWeekLoad {
  week: number
  /** Our players off that week, most expensive first — the order the roster reads in. */
  players: Player[]
  /** How many of them hold a starting slot in the lineup as it stands today. */
  starters: number
  /**
   * Starting slots that stay empty that week *after* the bench has been
   * shuffled in. This is the number that answers "can I still field a team?",
   * and it is not the same as `starters`: three starters out with three
   * eligible bench players behind them costs nothing.
   */
  holes: number
}

/**
 * Every bye week our roster touches, worst first.
 *
 * The coverage question is answered by re-running the lineup builder against
 * the roster minus that week's byes, rather than by counting positions by
 * hand. That reuses the one place that knows this league's slots — the
 * superflex-shaped OP slot especially, where a spare QB really can cover a
 * missing running back and a hand-rolled count would say otherwise.
 *
 * Holes are measured *against the roster's existing gaps*. Mid-draft the
 * lineup is mostly empty, so the raw count of unfilled starting slots in the
 * bye-week lineup would report a catastrophe every time; what's wanted is only
 * the slots the bye itself takes away.
 */
export function byeLoads(won: Pick[], byId: Map<number, Player>, slots: number): ByeWeekLoad[] {
  const base = buildLineup(won, byId, slots)
  const startingIds = new Set<number>()
  for (const row of base.starters) if (row.pick) startingIds.add(row.pick.playerId)

  const weeks = new Map<number, Pick[]>()
  for (const pick of won) {
    const week = byId.get(pick.playerId)?.byeWeek
    // Unknown byes are dropped rather than bucketed together: a schedule
    // outage must not invent a week that everyone is mysteriously off in.
    if (week === undefined) continue
    const bucket = weeks.get(week)
    if (bucket) bucket.push(pick)
    else weeks.set(week, [pick])
  }

  const loads: ByeWeekLoad[] = []
  for (const [week, out] of weeks) {
    const available = won.filter((pick) => byId.get(pick.playerId)?.byeWeek !== week)
    const weekLineup = buildLineup(available, byId, slots)

    loads.push({
      week,
      players: [...out]
        .sort((a, b) => b.price - a.price)
        .map((pick) => byId.get(pick.playerId))
        .filter((p): p is Player => Boolean(p)),
      starters: out.filter((pick) => startingIds.has(pick.playerId)).length,
      holes: Math.max(0, weekLineup.openStarters - base.openStarters),
    })
  }

  // Worst week first — that's the one you draft around. Ties break by week so
  // the list is stable as the roster fills.
  return loads.sort((a, b) => b.holes - a.holes || b.players.length - a.players.length || a.week - b.week)
}

/**
 * How many of our players are already off in each week.
 *
 * Deliberately a plain count rather than a `ByeWeekLoad`: the board asks this
 * once per row, for a week the player might not even share with us, and a
 * lineup rebuild per row would be paid ~230 times on every pick.
 */
export function byeCounts(won: Pick[], byId: Map<number, Player>): Map<number, number> {
  const counts = new Map<number, number>()
  for (const pick of won) {
    const week = byId.get(pick.playerId)?.byeWeek
    if (week === undefined) continue
    counts.set(week, (counts.get(week) ?? 0) + 1)
  }
  return counts
}
