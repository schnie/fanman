import { useMemo } from 'react'
import { wonPicksFrom, type BudgetSummary } from '../domain/budget'
import { buildLineup, type LineupRow } from '../domain/lineup'
import type { Pick, Player } from '../domain/types'
import { posClass } from '../lib/format'
import { isTeamEntity, teamAbbr } from '../data/proTeams'
import { PlayerAvatar } from './PlayerAvatar'

export function Roster({ picks, players, summary, slots }: {
  picks: Map<number, Pick>
  players: Player[]
  summary: BudgetSummary
  slots: number
}) {
  const lineup = useMemo(() => {
    const byId = new Map(players.map((p) => [p.id, p]))
    const won = wonPicksFrom(picks)
    return buildLineup(won, byId, slots)
  }, [picks, players, slots])

  return (
    <div className="pane">
      <div className="pane-summary">
        <div><strong>{summary.filled}</strong> won · <strong>${summary.spent}</strong> spent</div>
        <div><strong>${summary.remaining}</strong> left · <strong>{summary.slotsLeft}</strong> open</div>
      </div>

      <ul className="roster-list">
        {lineup.starters.map((row) => (
          <RosterRow key={row.key} row={row} />
        ))}
      </ul>

      {/* The hard line between a startable team and depth. */}
      <div className="bench-divider">
        <span>Bench</span>
        {lineup.openStarters > 0 && (
          <span className="bench-warn">
            {lineup.openStarters} starting {lineup.openStarters === 1 ? 'spot' : 'spots'} still open
          </span>
        )}
      </div>

      <ul className="roster-list">
        {lineup.bench.map((row) => (
          <RosterRow key={row.key} row={row} bench />
        ))}
      </ul>
    </div>
  )
}

function RosterRow({ row, bench }: { row: LineupRow; bench?: boolean }) {
  const empty = !row.pick
  const player = row.player
  // The board's guard, unchanged: D/ST and head coaches carry their team in
  // the crest, so "Texans D/ST · HOU" would say it twice. Asked by id, never
  // off the position label, so the two notions can't drift apart.
  const team = player && !isTeamEntity(player.id) ? teamAbbr(player.proTeamId) : null
  // OP is the only slot whose label and the position filling it can disagree.
  // That used to surface as a second chip to the right of the name, which read
  // as an unrelated badge floating in the middle of the row. Fold it into the
  // slot chip instead — `OP/WR` — so every position cue on the roster lives in
  // the one left-hand column, and tint the chip by what is actually in the
  // slot rather than by the slot's own name. Empty, it still says `OP`.
  const fillPos = player && player.position !== row.label ? player.position : null
  const slotLabel = fillPos ? `${row.label}/${fillPos}` : row.label

  return (
    <li className={`roster-row ${empty ? 'open' : ''} ${bench ? 'is-bench' : ''}`}>
      <span
        className={`slot slot-${posClass(fillPos ?? row.label)}`}
        title={fillPos ? `${row.label} slot, starting a ${fillPos}` : undefined}
      >
        {slotLabel}
      </span>

      {/* The face is what makes the board scannable, and the roster is the
          same list of people. An empty slot keeps the circle so the names stay
          on one straight left edge instead of sliding left wherever the lineup
          still has a hole.

          The face loads eagerly, inverting the board's default: this panel is
          `display: none` most of the time, and a lazy image in a hidden
          subtree never begins loading. At most `slots` faces, all of them ones
          the board has already fetched, so they come from the service
          worker. */}
      {player ? (
        <PlayerAvatar player={player} loading="eager" />
      ) : (
        <span className="avatar roster-avatar-open" aria-hidden="true" />
      )}

      <span className="roster-name">
        <span className="roster-player">
          {player?.name ?? (empty ? 'Empty' : `Player ${row.pick?.playerId}`)}
        </span>
        {team && <span className="row-team">{team}</span>}
        {player?.injured && (
          <span className="injury" title={player.injuryStatus ?? 'Injured'}>!</span>
        )}
      </span>

      <span className="roster-price">{row.pick ? `$${row.pick.price}` : '—'}</span>
    </li>
  )
}
