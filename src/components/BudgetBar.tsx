import type { BudgetSummary } from '../domain/budget'

/**
 * The permanent header. `maxBid` is deliberately the largest thing on screen —
 * it's the number you're staring at while someone counts down a bid.
 */
export function BudgetBar({ summary, onUndo, canUndo }: {
  summary: BudgetSummary
  onUndo: () => void
  canUndo: boolean
}) {
  return (
    <header className="budget-bar">
      <div className="budget-max">
        <span className="budget-label">Max bid</span>
        <span className="budget-max-value">
          {summary.rosterFull ? '—' : `$${summary.maxBid}`}
        </span>
      </div>

      <div className="budget-side">
        <Stat label="Left" value={`$${summary.remaining}`} />
        <Stat label="Slots" value={`${summary.slotsLeft}`} />
        {/* Pacing info rather than live-bidding info, so it's the first thing
            dropped when the header compacts on scroll. */}
        <Stat
          label="Avg/slot"
          value={summary.slotsLeft ? `$${summary.avgPerSlot.toFixed(0)}` : '—'}
          secondary
        />
        <button className="undo" onClick={onUndo} disabled={!canUndo} aria-label="Undo last action">
          Undo
        </button>
      </div>

      {summary.rosterFull && <div className="roster-full">Roster full — {summary.filled} players, ${summary.spent} spent</div>}
    </header>
  )
}

function Stat({ label, value, secondary }: { label: string; value: string; secondary?: boolean }) {
  return (
    <div className={`stat ${secondary ? 'secondary' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}
