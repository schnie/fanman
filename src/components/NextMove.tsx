import { postureFor, type MoveAdvice, type MoveReason, type NominationAdvice } from '../domain/nomination'
import type { Player } from '../domain/types'
import { posClass } from '../lib/format'
import { isTeamEntity, teamAbbr } from '../data/proTeams'

/**
 * The "what do I throw out next" banner.
 *
 * All the judgement lives in `domain/nomination`; this file owns only the
 * wording. Keeping the prose here rather than in the domain means copy edits
 * never touch the tested logic, and the tests assert postures instead of
 * sentences that will be reworded a dozen times before draft day.
 *
 * Tapping the suggestion searches for that player rather than opening a bid
 * sheet. A nomination is not a purchase, you still have to watch the room bid,
 * so the useful next action is "put him in front of me" — and it's the one
 * action that is harmless if the suggestion is wrong.
 */
export function NextMove({ advice, onFind }: {
  advice: NominationAdvice
  onFind: (player: Player) => void
}) {
  // Whether there is anything worth showing at all is the domain's call, not
  // this component's: it hands back `null` for that and an idle advice for a
  // board we simply can't bid into.
  if (advice.kind === 'idle') {
    return (
      <section className="nextmove" aria-label="Suggested nomination">
        <p className="nextmove-why">Nothing left you can bid on. Fill the rest at $1.</p>
      </section>
    )
  }

  const { player } = advice.pick
  const team = isTeamEntity(player.id) ? null : teamAbbr(player.proTeamId)

  return (
    <section
      className={`nextmove nextmove-${postureFor(advice.reason)}`}
      aria-label="Suggested nomination"
    >
      <div className="nextmove-head">
        <span className="nextmove-posture">{POSTURE_LABEL[advice.reason]}</span>
        {/* The comparison that decides the whole strategy, so it earns a spot
            in the header. Tilde and title text because it is a room average,
            not a fact about any one team. */}
        <span
          className="nextmove-rival"
          title="Estimated from the money and roster spots left across the room. An average, not any one team."
        >
          Field ~${advice.rivalMaxBid}
        </span>
      </div>

      <button className="nextmove-pick" onClick={() => onFind(player)}>
        <span className={`pos pos-${posClass(player.position)}`}>{player.position}</span>
        <span className="nextmove-name">
          {player.name}
          {team && <span className="nextmove-team">{team}</span>}
        </span>
        <span className="nextmove-open">
          <span className="nextmove-open-label">Open</span>${advice.pick.openAt}
        </span>
      </button>

      <p className="nextmove-why">{explain(advice)}</p>
    </section>
  )
}

/** Two or three words for the header chip. The sentence is `explain`'s job. */
const POSTURE_LABEL: Record<MoveReason, string> = {
  rich: 'Drain the room',
  behind: 'Buy now',
  bargains: 'Value is out there',
  endgame: 'Endgame',
  lastSlot: 'Last slot',
}

function explain({ reason, pick, rivalMaxBid, maxBid }: MoveAdvice): string {
  const likely = `Likely goes ~$${pick.expected}.`

  switch (reason) {
    case 'rich': {
      // "You don't need him" is only true once a slot has actually been
      // filled. At the opening nomination every position is still open, so the
      // case has to be made on the overpay and the cushion instead.
      const over = Math.round(pick.premium)
      const lead =
        over >= 1
          ? `The room is paying $${over} over book here. Let someone else spend it.`
          : pick.fillsNeed
            ? `Expensive enough to move real money out of the room.`
            : `You don't need him, and he'll move real money.`
      const cushion = pick.expected - pick.openAt
      return `${lead} ${likely} If it sticks at $${pick.openAt} you got him $${cushion} under.`
    }
    case 'behind':
      return `The field can outbid you (~$${rivalMaxBid} vs your $${maxBid}), so every round you wait puts your targets further out. ${likely}`
    case 'bargains':
      return `Prices are back to par, so draining now just hands value to whoever still has cash. ${likely} Open at $1.`
    case 'endgame':
      return `Rivals are down to ~$${rivalMaxBid} bids. Open at $1 and he's probably yours.`
    case 'lastSlot':
      return `One slot left. Spend it on someone you actually want. ${likely}`
  }
}
