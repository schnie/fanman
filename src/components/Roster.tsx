import { useMemo } from 'react'
import { wonPicksFrom, type BudgetSummary } from '../domain/budget'
import { buildLineup, type LineupRow } from '../domain/lineup'
import { byeLoads, type ByeWeekLoad } from '../domain/byes'
import type { Pick, Player } from '../domain/types'
import { posClass } from '../lib/format'
import { isTeamEntity, teamAbbr } from '../data/proTeams'
import { ByeChip } from './ByeChip'
import { PlayerAvatar } from './PlayerAvatar'

export function Roster({ picks, players, summary, slots }: {
  picks: Map<number, Pick>
  players: Player[]
  summary: BudgetSummary
  slots: number
}) {
  // One pass for both: the lineup and the bye plan read the same roster, and
  // splitting them meant building the id map and the won-pick list twice.
  const { lineup, byes } = useMemo(() => {
    const byId = new Map(players.map((p) => [p.id, p]))
    const won = wonPicksFrom(picks)
    return { lineup: buildLineup(won, byId, slots), byes: byeLoads(won, byId, slots) }
  }, [picks, players, slots])

  // Weeks the bench can't cover, so a row can say so where the player is.
  const uncovered = useMemo(
    () => new Set(byes.filter((load) => load.holes > 0).map((load) => load.week)),
    [byes],
  )

  return (
    <div className="pane">
      <div className="pane-summary">
        <div><strong>{summary.filled}</strong> won · <strong>${summary.spent}</strong> spent</div>
        <div><strong>${summary.remaining}</strong> left · <strong>{summary.slotsLeft}</strong> open</div>
      </div>

      {/* Above the lineup, not below it: it's the question you ask *between*
          nominations, and the roster is fifteen rows deep on a phone. */}
      <ByePlan loads={byes} />

      <ul className="roster-list">
        {lineup.starters.map((row) => (
          <RosterRow key={row.key} row={row} uncovered={uncovered} />
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
          <RosterRow key={row.key} row={row} bench uncovered={uncovered} />
        ))}
      </ul>
    </div>
  )
}

/**
 * The weeks our roster is off, worst first.
 *
 * Wording lives here and the arithmetic lives in `domain/byes.ts`, the same
 * split the next-move banner uses: a copy edit must never be able to change
 * what the number means.
 */
function ByePlan({ loads }: { loads: ByeWeekLoad[] }) {
  if (loads.length === 0) return null

  return (
    <section className="bye-plan">
      <h2 className="bye-plan-title">Bye weeks</h2>
      <ul className="bye-plan-list">
        {loads.map((load) => (
          <li key={load.week} className={`bye-plan-row${load.holes > 0 ? ' short' : ''}`}>
            <span className="bye-plan-week">Wk {load.week}</span>
            <span className="bye-plan-body">
              <span className="bye-plan-verdict">{describeLoad(load)}</span>
              <span className="bye-plan-names">
                {load.players.map((p) => p.name).join(', ')}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * "Uncovered" is the only line that means trouble: it says the bench cannot
 * refill a starting slot that week, however many players are out. Everything
 * else is reported plainly, because a bye you can cover is not a problem and
 * should not be dressed as one.
 *
 * The uncovered slots are *named* rather than counted, because the count alone
 * doesn't tell you what to do about it. "RB×2 uncovered" says go buy a back;
 * "2 starting slots uncovered" sends you back to the lineup to work out which.
 */
function describeLoad(load: ByeWeekLoad): string {
  if (load.holes > 0) return `${countSlots(load.uncovered)} uncovered`
  if (load.starters > 0) {
    return `${load.starters} ${load.starters === 1 ? 'starter' : 'starters'} out · bench covers`
  }
  return `${load.players.length} on the bench out`
}

/** `['RB', 'RB', 'OP']` → `RB×2, OP`, in the order the lineup lists them. */
function countSlots(labels: string[]): string {
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return [...counts].map(([label, n]) => (n > 1 ? `${label}×${n}` : label)).join(', ')
}

function RosterRow({ row, bench, uncovered }: {
  row: LineupRow
  bench?: boolean
  uncovered: Set<number>
}) {
  const empty = !row.pick
  const player = row.player
  // The board's guard, unchanged: D/ST and head coaches carry their team in
  // the crest, so "Texans D/ST · HOU" would say it twice. Asked by id, never
  // off the position label, so the two notions can't drift apart.
  const team = player && !isTeamEntity(player.id) ? teamAbbr(player.proTeamId) : null
  // The slot chip says where they're *starting*, which for OP is not what they
  // play. Shown only when the two disagree — anywhere else it would be the
  // same three letters twice.
  const offSlot = player && player.position !== row.label ? player.position : null

  return (
    <li className={`roster-row ${empty ? 'open' : ''} ${bench ? 'is-bench' : ''}`}>
      <span className={`slot slot-${posClass(row.label)}`}>{row.label}</span>

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
        {offSlot && <span className={`pos pos-${posClass(offSlot)}`}>{offSlot}</span>}
        {team && <span className="row-team">{team}</span>}
        <ByeChip
          week={player?.byeWeek}
          uncovered={player?.byeWeek !== undefined && uncovered.has(player.byeWeek)}
        />
        {player?.injured && (
          <span className="injury" title={player.injuryStatus ?? 'Injured'}>!</span>
        )}
      </span>

      <span className="roster-price">{row.pick ? `$${row.pick.price}` : '—'}</span>
    </li>
  )
}
