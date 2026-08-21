import type { ScoutReport, Verdict } from '../domain/types'
import { describeAge } from '../lib/format'

const LABEL: Record<Verdict, string> = {
  GREEN: 'Clear',
  CAUTION: 'Caution',
  RED: 'Risk',
}

/**
 * Compact verdict marker for the collapsed row — the whole point is that it is
 * readable in the half-second before you commit to a bid.
 */
export function ScoutChip({ report, loading }: { report?: ScoutReport; loading: boolean }) {
  if (loading) return <span className="scout-chip loading" title="Scouting…" />
  if (!report) return null
  return (
    <span className={`scout-chip ${report.verdict.toLowerCase()}`} title={report.headline}>
      {LABEL[report.verdict]}
    </span>
  )
}

/**
 * The detail, shown only once a row is expanded.
 *
 * `hasKey` means "scouting is possible right now" — App folds being online
 * into it — so every affordance here hangs off that one flag. Saying we are
 * offline is `PlayerRow`'s job; this panel is never mounted offline without a
 * report already in hand.
 */
export function ScoutPanel({ report, loading, error, hasKey, onScout }: {
  report?: ScoutReport
  loading: boolean
  error?: string
  hasKey: boolean
  onScout: () => void
}) {
  if (loading) {
    return <div className="scout-empty">Scouting…</div>
  }

  // Same inline treatment as the other one-liners: the card is reserved for an
  // actual report. "Retry" rather than "Scout again" — this is resuming a
  // failed attempt, not refreshing a finished one.
  if (error) {
    return (
      <div className="scout-empty error">
        <span>{error}</span>
        {hasKey && <button className="scout-link" onClick={onScout}>Retry</button>}
      </div>
    )
  }

  // Nothing to show yet. Deliberately no panel chrome: a bordered, padded box
  // containing one button reads as an empty section rather than an action.
  if (!report) {
    return (
      <div className="scout-empty">
        {hasKey ? (
          <button className="scout-link" onClick={onScout}>Scout this player</button>
        ) : (
          <span>Add an API key in Settings to scout players.</span>
        )}
      </div>
    )
  }

  return (
    <div className={`scout-panel ${report.verdict.toLowerCase()}`}>
      <div className="scout-head">
        <ScoutChip report={report} loading={false} />
        <span className="scout-headline">{report.headline}</span>
      </div>

      {report.notes.length > 0 && (
        <ul className="scout-notes">
          {report.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}

      {report.sources.length > 0 && (
        <div className="scout-sources">
          {report.sources.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener">
              {s.title}
            </a>
          ))}
        </div>
      )}

      <div className="scout-foot">
        {/* Reports survive a refresh, so the age has to be visible — a restored
            report must not read as though it were just fetched. */}
        <span className="scout-age">Scouted {describeAge(report.fetchedAt)}</span>
        {/* A re-check that cannot run — no key, or offline — is a button that
            silently does nothing when tapped. The age stays either way, so a
            restored report never reads as fresh. */}
        {hasKey && <button className="scout-run" onClick={onScout}>Scout again</button>}
      </div>
    </div>
  )
}
