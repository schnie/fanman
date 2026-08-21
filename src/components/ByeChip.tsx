/**
 * A player's bye week, flagged when it's a week we're already thin at their
 * position.
 *
 * Shared by the board and the roster deliberately: it's the same fact about
 * the same person, and the two tabs get read one after the other — a chip that
 * changed shape between them would read as a different number.
 *
 * Silent when the week is unknown, which happens for real: the schedule call
 * fails independently of the rankings, and a board restored from a cache that
 * predates the field carries no byes at all. An invented "Bye —" would be read
 * as a fact about the player rather than a gap in what we fetched.
 */
export function ByeChip({
  week,
  position,
  clash,
  uncovered,
}: {
  week?: number
  /** Board: what the clash count is counting, so the tooltip can name it. */
  position?: string
  /**
   * Board: how many players we already own *at this position* are off that
   * same week. Position-scoped because that's who could have covered the slot
   * — see `domain/byes.ts`.
   */
  clash?: number
  /** Roster: that week leaves a starting slot we can't fill from the bench. */
  uncovered?: boolean
}) {
  if (week === undefined) return null
  const stacked = (clash ?? 0) > 0

  return (
    <span
      className={`row-bye${uncovered || stacked ? ' clash' : ''}`}
      title={
        uncovered
          ? `Off in week ${week} — that week leaves a starting slot uncovered`
          : stacked
            ? `Off in week ${week} — so ${clash === 1 ? 'is' : 'are'} ${clash} of your ${position ?? 'player'}s`
            : `Off in week ${week}`
      }
    >
      Bye {week}
      {stacked && <span className="row-bye-count">+{clash}</span>}
    </span>
  )
}
