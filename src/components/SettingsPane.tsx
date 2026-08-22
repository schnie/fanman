import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type Scoring, type Settings } from '../domain/types'
import type { DataAdapter } from '../data/adapter'
import type { AppUpdates, UpdateCheck } from '../lib/appUpdate'
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
  updates,
  online,
}: {
  settings: Settings
  fetchedAt: number | null
  onChange: (patch: Partial<Settings>) => void
  onRefresh: () => void
  onReset: () => void
  adapter: DataAdapter
  scoutCalls: number
  onKeyChange: () => void
  /** Absent where there is no service worker to update — see `App`. */
  updates?: AppUpdates
  /** Only the reinstall cares, and only so it can refuse to run offline. */
  online: boolean
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
      <NumberField
        label="Budget"
        value={settings.budget}
        min={1}
        max={10_000}
        fallback={DEFAULT_SETTINGS.budget}
        onCommit={(budget) => onChange({ budget })}
      />

      <NumberField
        label="Roster slots"
        value={settings.slots}
        min={1}
        max={40}
        fallback={DEFAULT_SETTINGS.slots}
        onCommit={(slots) => onChange({ slots })}
      />

      <NumberField
        label="Teams"
        value={settings.teamCount}
        min={2}
        max={32}
        fallback={DEFAULT_SETTINGS.teamCount}
        onCommit={(teamCount) => onChange({ teamCount })}
      />

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

      <NumberField
        label="Auto-scout top N"
        value={settings.prewarmDepth}
        min={0}
        max={40}
        fallback={DEFAULT_SETTINGS.prewarmDepth}
        onCommit={(prewarmDepth) => onChange({ prewarmDepth })}
      />
      <div className="field-note">
        Scouts the top N available players in the background so a verdict is
        already waiting when a name is called. Each scout is a paid API call, so
        set 0 to only scout players you tap. <strong>{scoutCalls}</strong> run
        this session.
      </div>

      {updates && (
        <>
          <hr />
          <AppVersion updates={updates} online={online} />
        </>
      )}

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

/** `idle` is "hasn't been asked yet", which is not the same as `current`. */
type CheckState = 'idle' | 'checking' | UpdateCheck

/** The reinstall's own progression, kept apart from the check's. */
type ReinstallState = 'idle' | 'confirm' | 'working' | 'failed'

/**
 * What the note under the button says. Split out so the copy is editable
 * without touching the state machine, the same way `NextMove` keeps wording
 * away from judgement.
 */
const CHECK_NOTE: Record<CheckState, string> = {
  idle: 'Installed apps only look for new code when they are reopened, and iOS often skips that. This asks now.',
  checking: 'Asking the server for a newer build…',
  current: "You're on the latest build.",
  updating: 'A newer build is downloading. The app will reload itself when it lands.',
  failed: "Couldn't reach the server. Check the connection and try again.",
  unsupported: 'This browser is not running the offline app, so a plain refresh already gets you the latest.',
}

/**
 * "Which build am I on, and how do I get the new one?" — two questions a
 * home-screen install could not answer, because it has no address bar to read
 * and no refresh button to press. See `lib/appUpdate.ts` for why the automatic
 * path needed help and why re-adding the icon is not an acceptable answer.
 */
function AppVersion({ updates, online }: { updates: AppUpdates; online: boolean }) {
  const [state, setState] = useState<CheckState>('idle')
  const [reinstall, setReinstall] = useState<ReinstallState>('idle')

  const check = async () => {
    setState('checking')
    try {
      setState(await updates.check())
    } catch {
      // A check that threw is a check that did not happen. Leaving the button
      // spinning on "Checking…" forever is the only outcome worse than saying
      // so, and it takes the retry with it.
      setState('failed')
    }
  }

  const runReinstall = async () => {
    setReinstall('working')
    try {
      await updates.reinstall()
      // On success the page is already reloading; there is no "after" to render.
    } catch {
      setReinstall('failed')
    }
  }

  // `updating` stays disabled too: the reload is already on its way, and a
  // second check in the meantime can only confuse the story.
  const busy = state === 'checking' || state === 'updating'

  return (
    <>
      <h3 className="pane-heading">App version</h3>
      <div className="field-note">
        Running build <strong>{updates.version}</strong>.
      </div>
      <button className="wide" onClick={check} disabled={busy}>
        {state === 'checking' ? 'Checking…' : 'Check for update'}
      </button>
      <div className="field-note">{CHECK_NOTE[state]}</div>

      {reinstall === 'confirm' ? (
        <div className="danger-confirm">
          <p>
            Download the app again from scratch? Your picks, settings and API key
            are stored separately and will survive.
          </p>
          <div className="danger-actions">
            <button onClick={() => setReinstall('idle')}>Cancel</button>
            <button className="danger" onClick={runReinstall}>
              Reinstall
            </button>
          </div>
        </div>
      ) : (
        <button
          className="wide danger-outline"
          onClick={() => setReinstall('confirm')}
          /*
           * Offline this is destructive with no upside: it deletes the cached
           * app and then has nowhere to download it from, so the phone is left
           * with a dead icon until the network comes back. That is the exact
           * situation the rest of the app is built to survive, so the one
           * control that can't survive it refuses to run.
           */
          disabled={!online || reinstall === 'working'}
        >
          {reinstall === 'working' ? 'Reinstalling…' : 'Reinstall app files'}
        </button>
      )}
      <div className="field-note">{reinstallNote(online, reinstall)}</div>
    </>
  )
}

function reinstallNote(online: boolean, state: ReinstallState): string {
  if (state === 'failed') {
    return 'Could not clear the cached app — this browser may be blocking storage. Try again, or reopen the app from the home screen.'
  }
  if (!online) {
    return 'Needs a connection: this deletes the cached app before fetching it again, so offline it would leave nothing to run.'
  }
  return 'For when the check keeps saying you are up to date and you know a new version shipped. Clears the cached app and fetches it fresh. Reach for this instead of deleting the home-screen icon, which takes the draft with it.'
}

/**
 * A settings number that only reaches the draft once it is a whole, in-range
 * number.
 *
 * These were plain controlled inputs that clamped every keystroke and pushed
 * the result straight into settings, which made them impossible to *edit*:
 * select the budget, hit backspace, and the empty string clamped to the default
 * and reappeared under the cursor before the next digit landed. Typing `10`
 * into a field with a minimum of 2 became `2`, then `20`. You could append
 * digits and nothing else.
 *
 * So the field keeps its own draft text while you are in it and shows the
 * committed value the rest of the time. Half-typed states — empty, `1` on the
 * way to `10`, anything past the maximum — are allowed to exist in the box
 * without existing in the draft.
 *
 * A value that is *already* acceptable still commits on the keystroke rather
 * than waiting for blur, so an edit can't be lost to a tab switch or a reload
 * that never fires a blur. That also keeps the pre-warm dial honest: every
 * value it commits mid-typing is a prefix of the one being typed, so it can
 * only ever scout a subset of what you are asking for, never a stranger.
 */
function NumberField({
  label,
  value,
  min,
  max,
  fallback,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  fallback: number
  onCommit: (n: number) => void
}) {
  /** `null` means "not being edited" — the committed value shows through. */
  const [draft, setDraft] = useState<string | null>(null)

  const change = (raw: string) => {
    setDraft(raw)
    const n = parseInt(raw, 10)
    if (!Number.isNaN(n) && String(n) === raw.trim() && n >= min && n <= max) onCommit(n)
  }

  const settle = () => {
    if (draft !== null) onCommit(clamp(draft, min, max, fallback))
    setDraft(null)
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={draft ?? value}
        min={min}
        max={max}
        onChange={(e) => change(e.target.value)}
        onBlur={settle}
        /*
         * A phone keyboard's done key blurs the field; a hardware Enter does
         * not, and there is no form here to submit to. Without this the number
         * you typed sits in the box looking committed when it isn't.
         */
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      />
    </label>
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
