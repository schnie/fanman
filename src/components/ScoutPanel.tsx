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
  if (loading) return <span className="scout-chip loading" title="Checking for news…" />
  if (!report) return null
  return (
    <span className={`scout-chip ${report.verdict.toLowerCase()}`} title={report.headline}>
      {LABEL[report.verdict]}
    </span>
  )
}

/** The detail, shown only once a row is expanded. */
export function ScoutPanel({ report, loading, error, hasKey, offline, onScout }: {
  report?: ScoutReport
  loading: boolean
  error?: string
  hasKey: boolean
  offline?: boolean
  onScout: () => void
}) {
  if (loading) {
    return <div className="scout-panel muted">Checking recent news…</div>
  }

  if (error) {
    return (
      <div className="scout-panel error">
        <span>{error}</span>
        {hasKey && <button onClick={onScout}>Retry</button>}
      </div>
    )
  }

  if (!report) {
    return (
      <div className="scout-panel muted">
        {hasKey ? (
          <button className="scout-run" onClick={onScout}>Check for news</button>
        ) : (
          <span>{offline ? 'Offline — news checks need a connection.' : 'Add an API key in Settings to check for news.'}</span>
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
        <span className="scout-age">Checked {describeAge(report.fetchedAt)}</span>
        <button className="scout-run" onClick={onScout}>Re-check</button>
      </div>
    </div>
  )
}
