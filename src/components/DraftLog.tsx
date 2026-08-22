import { useMemo } from 'react'
import { buildDraftLog, type DraftLogEntry } from '../domain/draftLog'
import type { Pick, Player } from '../domain/types'
import { posClass } from '../lib/format'
import { isTeamEntity, teamAbbr } from '../data/proTeams'

/**
 * The draft as it happened — every player crossed off, in order, most recent
 * first.
 *
 * A secondary view by design. Nothing here changes the draft and nothing here
 * costs anything: it exists for the two questions the board cannot answer
 * because the board is a list of who is *left*. "Did so-and-so go already?"
 * and "what did the last few actually sell for?" — usually asked by whoever
 * you have just handed the phone to.
 *
 * Most recent first because that is where both of those questions live, and
 * because a phone opens at the top: read chronologically the useful end would
 * be a hundred rows down by the middle rounds. The pick number restores the
 * running order the reversal takes away, so nobody has to count.
 */
export function DraftLog({ log, players }: { log: Pick[]; players: Player[] }) {
  const entries = useMemo(
    () => buildDraftLog(log, new Map(players.map((p) => [p.id, p]))),
    [log, players],
  )
  const ours = entries.filter((e) => e.status === 'mine').length

  if (entries.length === 0) {
    return (
      <div className="pane">
        <p className="empty">
          Nothing off the board yet. Every player you cross off shows up here, in order.
        </p>
      </div>
    )
  }

  return (
    <div className="pane">
      <div className="pane-summary">
        <div>
          <strong>{entries.length}</strong> off the board
        </div>
        <div>
          <strong>{ours}</strong> {ours === 1 ? 'is' : 'are'} ours
        </div>
      </div>

      {/* Numbered explicitly rather than by an <ol> counter: the list runs
          backwards, and a reversed counter would need `reversed` plus a start
          that changes on every pick. The number is content here — it is the
          pick's name in the room's conversation. */}
      <ul className="log-list">
        {entries.map((entry) => (
          <LogRow key={entry.playerId} entry={entry} />
        ))}
      </ul>
    </div>
  )
}

function LogRow({ entry }: { entry: DraftLogEntry }) {
  const player = entry.player
  // Same guard as the board and the roster: D/ST and head coaches carry their
  // team in their name, so repeating it would say it twice. Asked by id, never
  // off the position label.
  const team = player && !isTeamEntity(player.id) ? teamAbbr(player.proTeamId) : null

  return (
    <li className={`log-row ${entry.status}`}>
      <span className="log-num">{entry.number}</span>

      {/* The roster's fixed-width slot chip rather than the board's snug one:
          this list is read straight down, and a chip that changes width with
          its label puts a kink in the left edge of every name beside it. */}
      {player ? (
        <span className={`slot slot-${posClass(player.position)}`}>{player.position}</span>
      ) : (
        <span className="slot" title="Not on the current board">?</span>
      )}

      <span className="log-name">
        {/* Wrapped so the name is the thing that truncates, leaving the chips
            beside it whole — the board's rule, for the same reason. */}
        <span className="log-player">{player?.name ?? `Player ${entry.playerId}`}</span>
        {team && <span className="row-team">{team}</span>}
        {entry.status === 'mine' && <span className="tag mine">Mine</span>}
      </span>

      {/* A price we never caught stays blank. The board estimates what a
          player will go for; the log is a record of what happened, and an
          estimate in a record would read as a fact. */}
      <span className="log-price">{entry.price === undefined ? '—' : `$${entry.price}`}</span>
    </li>
  )
}
