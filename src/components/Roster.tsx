import { useMemo, useState } from 'react'
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

  // Which positions each week is actually short at, so a row can flag the
  // player it's about. Keyed by week and asked with the player's own position:
  // a week can be short at back and perfectly fine at receiver, and the
  // receiver with three bodies behind him is not the problem.
  const shortAt = useMemo(() => {
    const map = new Map<number, Set<string>>()
    for (const load of byes) {
      if (load.holes > 0) map.set(load.week, new Set(load.uncoveredPositions))
    }
    return map
  }, [byes])

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
          <RosterRow key={row.key} row={row} shortAt={shortAt} />
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
          <RosterRow key={row.key} row={row} bench shortAt={shortAt} />
        ))}
      </ul>
    </div>
  )
}

/**
 * The weeks our roster is off, worst first.
 *
 * Only the weeks that actually cost a starting slot are shown; the covered
 * ones fold away behind the count. A bye you can cover is not news, and above
 * a lineup you're trying to read on a phone, six reassuring rows push the
 * problem week off the screen — which is the one thing this block exists to
 * put in front of you. The full story stays one tap away.
 *
 * Expanding survives a trip to the board, because this panel is hidden between
 * tabs rather than unmounted. That's the right behaviour to inherit and not
 * something to undo: opening it is a deliberate act, and re-folding it behind
 * your back would read as the app losing your place. The alerts stay on top
 * either way — `loads` is worst-first, so the covered weeks only ever appear
 * beneath them.
 *
 * Wording lives here and the arithmetic lives in `domain/byes.ts`, the same
 * split the next-move banner uses: a copy edit must never be able to change
 * what the number means.
 */
function ByePlan({ loads }: { loads: ByeWeekLoad[] }) {
  const [open, setOpen] = useState(false)
  if (loads.length === 0) return null

  // `loads` arrives worst-first, so this is a partition and never a re-sort:
  // the rows keep the same order whether they're folded or not.
  const alerting = loads.filter((load) => load.holes > 0)
  const covered = loads.length - alerting.length
  const shown = open ? loads : alerting

  return (
    <section className="bye-plan">
      <div className="bye-plan-head">
        <h2 className="bye-plan-title">Bye weeks</h2>
        {covered > 0 && (
          <button
            type="button"
            className="bye-plan-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide covered' : `${covered} covered`}
            <span className="bye-plan-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
        )}
      </div>

      {/* Nothing alerting and nothing expanded: say so outright rather than
          leaving a bare heading, which reads as a section that failed to
          load. */}
      {shown.length === 0 && <p className="bye-plan-clear">Every bye week is covered.</p>}

      <ul className="bye-plan-list">
        {shown.map((load) => (
          <li key={load.week} className={`bye-plan-row${load.holes > 0 ? ' short' : ''}`}>
            <span className="bye-plan-week">Wk {load.week}</span>
            <span className="bye-plan-body">
              <span className="bye-plan-verdict">{describeLoad(load)}</span>
              <span className="bye-plan-names">{describePlayers(load)}</span>
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

/**
 * Who the line is about.
 *
 * On a week that costs a slot, only the players at the positions actually
 * short are named — listing everyone off that week put a receiver with three
 * bodies behind him next to an "RB uncovered" headline, which reads as though
 * he were half the problem. The others are counted, not named, so the week's
 * full weight is still visible.
 *
 * On a covered week there is no alert to be about, so everyone out is named.
 */
function describePlayers(load: ByeWeekLoad): string {
  if (load.holes === 0) return load.players.map((p) => p.name).join(', ')

  const short = load.players.filter((p) => load.uncoveredPositions.includes(p.position))
  const rest = load.players.length - short.length
  const names = short.map((p) => p.name).join(', ')
  return rest > 0 ? `${names} · +${rest} covered` : names
}

/** `['RB', 'RB', 'OP']` → `RB×2, OP`, in the order the lineup lists them. */
function countSlots(labels: string[]): string {
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return [...counts].map(([label, n]) => (n > 1 ? `${label}×${n}` : label)).join(', ')
}

function RosterRow({ row, bench, shortAt }: {
  row: LineupRow
  bench?: boolean
  /** Week → the positions that week is short at. */
  shortAt: Map<number, Set<string>>
}) {
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
        <ByeChip
          week={player?.byeWeek}
          uncovered={
            player?.byeWeek !== undefined &&
            (shortAt.get(player.byeWeek)?.has(player.position) ?? false)
          }
        />
        {player?.injured && (
          <span className="injury" title={player.injuryStatus ?? 'Injured'}>!</span>
        )}
      </span>

      <span className="roster-price">{row.pick ? `$${row.pick.price}` : '—'}</span>
    </li>
  )
}
