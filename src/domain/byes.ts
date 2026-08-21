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
   * The *labels* of the starting slots that stay empty that week once the
   * bench has been shuffled in — `['RB', 'RB', 'OP']`. Which slots go dark is
   * the actionable half: it names the position to go shopping for, where a
   * bare count only says something is wrong.
   */
  uncovered: string[]
  /**
   * `uncovered.length`, kept as its own field because it's what the wording
   * and the flagging branch on and re-deriving a length at three call sites
   * invites one of them to drift.
   */
  holes: number
}

/**
 * Every bye week our roster touches, worst first.
 *
 * The coverage question is answered by re-running the lineup builder against
 * the roster minus that week's byes, rather than by counting positions by
 * hand. That reuses the one place that knows this league's slots, and it is
 * what makes the answer position-aware for free: backs on bye can only ever
 * empty back-shaped slots, so a week full of missing receivers never reports a
 * quarterback problem. The superflex-shaped OP slot is the reason this can't
 * be a positional tally — a spare QB really can cover a missing back there,
 * and only the lineup builder knows it.
 *
 * Holes are the slots the bye *takes away*: only slots the roster fills today
 * can be lost. Mid-draft the lineup is mostly empty, and counting every
 * unfilled slot in the bye-week lineup would report a catastrophe every time.
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

    // Same slot list in both lineups, so a slot filled today and empty that
    // week is a slot the bye cost us. A shrinking pool never fills a slot it
    // couldn't fill before, so this is exactly the damage and never more.
    const filledThatWeek = new Set(
      weekLineup.starters.filter((row) => row.pick).map((row) => row.key),
    )
    const uncovered = base.starters
      .filter((row) => row.pick && !filledThatWeek.has(row.key))
      .map((row) => row.label)

    loads.push({
      week,
      players: [...out]
        .sort((a, b) => b.price - a.price)
        .map((pick) => byId.get(pick.playerId))
        .filter((p): p is Player => Boolean(p)),
      starters: out.filter((pick) => startingIds.has(pick.playerId)).length,
      uncovered,
      holes: uncovered.length,
    })
  }

  // Worst week first — that's the one you draft around. Ties break by week so
  // the list is stable as the roster fills.
  return loads.sort((a, b) => b.holes - a.holes || b.players.length - a.players.length || a.week - b.week)
}

/**
 * How many players we already own are off in a given week *at a given
 * position*.
 *
 * Position-scoped on purpose. A bye hurts when the slot behind it can't be
 * refilled, and the players who refill a slot are the ones who play that
 * position — so three receivers off in week 8 say nothing about the
 * quarterback you're bidding on, and counting them would flag every row on the
 * board with a number that means nothing. Total damage for a week is the
 * roster tab's job, where the lineup builder can answer it properly.
 */
export interface ByeCounts {
  at(position: string, week: number): number
}

export function byeCounts(won: Pick[], byId: Map<number, Player>): ByeCounts {
  const counts = new Map<string, number>()

  for (const pick of won) {
    const player = byId.get(pick.playerId)
    if (player?.byeWeek === undefined) continue
    const key = `${player.position}|${player.byeWeek}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return {
    at: (position, week) => counts.get(`${position}|${week}`) ?? 0,
  }
}
