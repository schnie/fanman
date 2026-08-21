import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type Scoring, type Settings } from '../domain/types'
import type { DataAdapter } from '../data/adapter'
import { describeAge } from '../lib/format'

/**
 * A password manager treats any `type="password"` holding a saved value as a
 * login field: it offers to fill it unprompted, and its inline overlay can
 * outlive the input it was anchored to. `autocomplete="off"` does not help —
 * browsers deliberately ignore it on password inputs. So where the browser can
 * mask a plain text input in CSS, the key field is a text input and never looks
 * like a credential in the first place.
 *
 * Detected once, before first render, rather than swapped in afterwards: a
 * field that is briefly a password input on mount has already been seen. Where
 * masking is unsupported we keep `type="password"`, because a key rendered in
 * the clear on a phone held up in a room full of people is the worse failure.
 */
const MASK_TEXT =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('-webkit-text-security', 'disc')

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
          onChange={(e) => onChange({ budget: clamp(e.target.value, 1, 10_000, DEFAULT_SETTINGS.budget) })}
        />
      </label>

      <label className="field">
        <span>Roster slots</span>
        <input
          type="number"
          inputMode="numeric"
          value={settings.slots}
          min={1}
          onChange={(e) => onChange({ slots: clamp(e.target.value, 1, 40, DEFAULT_SETTINGS.slots) })}
        />
      </label>

      <label className="field">
        <span>Teams</span>
        <input
          type="number"
          inputMode="numeric"
          value={settings.teamCount}
          min={2}
          onChange={(e) => onChange({ teamCount: clamp(e.target.value, 2, 32, DEFAULT_SETTINGS.teamCount) })}
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
        Pull again right before the draft, because auction values move daily.
      </div>
      <button className="wide" onClick={onRefresh}>Refresh rankings</button>

      <hr />

      <h3 className="pane-heading">Scout</h3>
      <label className="field field-stacked">
        <span>Anthropic API key</span>
        <input
          /*
           * Not `type="password"` when we can avoid it — see MASK_TEXT above.
           * The vendor opt-outs below are the only documented way to tell each
           * extension to leave a field alone; they cost nothing on browsers
           * where no such extension is installed.
           */
          type={MASK_TEXT ? 'text' : 'password'}
          className={MASK_TEXT ? 'key-input key-input-masked' : 'key-input'}
          value={apiKey}
          placeholder="sk-ant-…"
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <button className="wide" onClick={saveKey}>
        {keySaved ? 'Saved' : 'Save key'}
      </button>
      <div className="field-note">
        Stored on this device only, since this app has no server. Use a dedicated
        key with a spend cap and revoke it after the draft. Keys live at{' '}
        <a href="https://platform.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          platform.anthropic.com
        </a>.
      </div>

      <label className="field">
        <span>Auto-scout top N</span>
        <input
          type="number"
          inputMode="numeric"
          value={settings.prewarmDepth}
          min={0}
          max={40}
          onChange={(e) => onChange({ prewarmDepth: clamp(e.target.value, 0, 40, DEFAULT_SETTINGS.prewarmDepth) })}
        />
      </label>
      <div className="field-note">
        Scouts the top N available players in the background so a verdict is
        already waiting when a name is called. Each scout is a paid API call, so
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

/**
 * `fallback` is what an emptied field falls back to, and it comes from
 * `DEFAULT_SETTINGS` rather than a literal at the call site — those were a
 * second copy of the defaults, and they had already drifted: roster slots
 * defaulted to 17 but reverted to 16 when you cleared the box.
 */
function clamp(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
