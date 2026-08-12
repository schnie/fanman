import { useMemo } from 'react'
import { wonPicksFrom, type BudgetSummary } from '../domain/budget'
import { buildLineup, type LineupRow } from '../domain/lineup'
import type { Pick, Player } from '../domain/types'
import { posClass } from '../lib/format'

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
  return (
    <li className={`roster-row ${empty ? 'open' : ''} ${bench ? 'is-bench' : ''}`}>
      <span className={`slot slot-${posClass(row.label)}`}>{row.label}</span>
      <span className="roster-name">
        {row.player?.name ?? (empty ? 'Empty' : `Player ${row.pick?.playerId}`)}
      </span>
      <span className="roster-price">{row.pick ? `$${row.pick.price}` : '—'}</span>
    </li>
  )
}
