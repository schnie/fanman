import type { BudgetSummary } from '../domain/budget'
import { inflationIsMeaningful, type MarketState } from '../domain/market'

/**
 * The permanent header. `maxBid` is deliberately the largest thing on screen —
 * it's the number you're staring at while someone counts down a bid.
 */
export function BudgetBar({ summary, onUndo, canUndo, online, market }: {
  summary: BudgetSummary
  onUndo: () => void
  canUndo: boolean
  online: boolean
  market: MarketState
}) {
  return (
    <header className="budget-bar">
      <div className="budget-max">
        <span className="budget-label">
          Max bid
          {/* The board works offline; only the scout doesn't. Say so quietly
              rather than letting it fail with a bare network error. */}
          {!online && <span className="offline-dot" title="Offline — the board works, the scout won't">Offline</span>}
        </span>
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
        {/* How much real money is chasing each dollar of listed value. Above 1
            means the sheet is under-pricing this room. */}
        {inflationIsMeaningful(market.inflation) && (
          <Stat
            label="Room"
            value={`×${market.inflation.toFixed(2)}${market.confident ? '' : '?'}`}
            secondary
            title={
              market.confident
                ? `$${market.moneyLeft} left chasing $${Math.round(market.valueLeft)} of listed value`
                : 'Few players left — this figure is rough'
            }
          />
        )}
        <button className="undo" onClick={onUndo} disabled={!canUndo} aria-label="Undo last action">
          Undo
        </button>
      </div>

      {summary.rosterFull && <div className="roster-full">Roster full — {summary.filled} players, ${summary.spent} spent</div>}
    </header>
  )
}

function Stat({ label, value, secondary, title }: {
  label: string
  value: string
  secondary?: boolean
  title?: string
}) {
  return (
    <div className={`stat ${secondary ? 'secondary' : ''}`} title={title}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}
