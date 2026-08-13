import { useEffect, useState } from 'react'
import type { Scoring, Settings } from '../domain/types'
import type { DataAdapter } from '../data/adapter'
import { describeAge } from '../lib/format'

export function SettingsPane({
  settings,
  fetchedAt,
  onChange,
  onRefresh,
  onReset,
  adapter,
  scoutCalls,
  onKeyChange,
}: {
  settings: Settings
  fetchedAt: number | null
  onChange: (patch: Partial<Settings>) => void
  onRefresh: () => void
  onReset: () => void
  adapter: DataAdapter
  scoutCalls: number
  onKeyChange: () => void
}) {
  const [confirmReset, setConfirmReset] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keySaved, setKeySaved] = useState(false)

  useEffect(() => {
    adapter.loadApiKey().then((k) => setApiKey(k ?? ''))
  }, [adapter])

  const saveKey = async () => {
    await adapter.saveApiKey(apiKey.trim())
    onKeyChange()
    setKeySaved(true)
    setTimeout(() => setKeySaved(false), 2000)
  }

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

      <h3 className="pane-heading">Scout</h3>
      <label className="field field-stacked">
        <span>Anthropic API key</span>
        <input
          type="password"
          value={apiKey}
          placeholder="sk-ant-…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <button className="wide" onClick={saveKey}>
        {keySaved ? 'Saved' : 'Save key'}
      </button>
      <div className="field-note">
        Stored on this device only — this app has no server. Use a dedicated key
        with a spend cap and revoke it after the draft.
      </div>

      <label className="field">
        <span>Auto-scout top N</span>
        <input
          type="number"
          inputMode="numeric"
          value={settings.prewarmDepth}
          min={0}
          max={40}
          onChange={(e) => onChange({ prewarmDepth: clamp(e.target.value, 0, 40, 10) })}
        />
      </label>
      <div className="field-note">
        Scouts the top N available players in the background so a verdict is
        already waiting when a name is called. Each scout is a paid API call —
        set 0 to only scout players you tap. <strong>{scoutCalls}</strong> run
        this session.
      </div>

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
