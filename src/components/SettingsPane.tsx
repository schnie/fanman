import { useState } from 'react'
import type { Scoring, Settings } from '../domain/types'
import { describeAge } from '../lib/format'

export function SettingsPane({ settings, fetchedAt, onChange, onRefresh, onReset }: {
  settings: Settings
  fetchedAt: number | null
  onChange: (patch: Partial<Settings>) => void
  onRefresh: () => void
  onReset: () => void
}) {
  const [confirmReset, setConfirmReset] = useState(false)

  return (
    <div className="pane">
      <label className="field">
        <span>Budget</span>
        <input
          type="number"
          inputMode="numeric"
          value={settings.budget}
          min={1}
          onChange={(e) => onChange({ budget: clamp(e.target.value, 1, 10_000, 200) })}
        />
      </label>

      <label className="field">
        <span>Roster slots</span>
        <input
          type="number"
          inputMode="numeric"
          value={settings.slots}
          min={1}
          onChange={(e) => onChange({ slots: clamp(e.target.value, 1, 40, 16) })}
        />
      </label>

      <label className="field">
        <span>Teams</span>
        <input
          type="number"
          inputMode="numeric"
          value={settings.teamCount}
          min={2}
          onChange={(e) => onChange({ teamCount: clamp(e.target.value, 2, 32, 12) })}
        />
      </label>

      <label className="field">
        <span>Scoring</span>
        <select value={settings.scoring} onChange={(e) => onChange({ scoring: e.target.value as Scoring })}>
          <option value="PPR">PPR</option>
          <option value="STANDARD">Standard</option>
        </select>
      </label>

      <div className="field-note">
        Rankings {fetchedAt ? `updated ${describeAge(fetchedAt)}` : 'not yet loaded'}.
        Pull again right before the draft — auction values move daily.
      </div>
      <button className="wide" onClick={onRefresh}>Refresh rankings</button>

      <hr />

      {confirmReset ? (
        <div className="danger-confirm">
          <p>Clear every pick and start over? This cannot be undone.</p>
          <div className="danger-actions">
            <button onClick={() => setConfirmReset(false)}>Cancel</button>
            <button className="danger" onClick={() => { onReset(); setConfirmReset(false) }}>
              Reset draft
            </button>
          </div>
        </div>
      ) : (
        <button className="wide danger-outline" onClick={() => setConfirmReset(true)}>
          Reset draft
        </button>
      )}
    </div>
  )
}

function clamp(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
