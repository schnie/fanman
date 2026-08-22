import { useEffect, useRef, useState } from 'react'
import type { ChatTurn } from '../domain/types'

/**
 * Openers for an empty transcript.
 *
 * Not decoration: the useful questions here are not the ones people think to
 * ask a chat box. "Who should I nominate" is obvious; "what happens to my
 * lineup in week 9" is the one that earns the feature, and nobody types it
 * unprompted with a room counting down.
 */
const OPENERS = [
  'Who should I nominate next?',
  'What position am I weakest at?',
  'Is my week 9 bye a problem?',
  'What should I pay for the best QB left?',
]

function Sources({ sources }: { sources: NonNullable<ChatTurn['sources']> }) {
  return (
    <div className="chat-sources">
      {sources.map((s) => (
        <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener">
          {s.title}
        </a>
      ))}
    </div>
  )
}

/**
 * The draft chat.
 *
 * Every answer here is a model's, and the app spends the rest of its surface
 * being careful about the difference between a number ESPN published and one
 * we worked out. So the whole pane is marked as model output rather than
 * trusting the prose to say so each time — see `.chat-turn.assistant` in
 * `App.css` and the standing note under the transcript.
 */
export function ChatPane({
  turns,
  streaming,
  searching,
  calls,
  hasKey,
  online,
  onSend,
  onRetry,
  onNewTopic,
}: {
  turns: ChatTurn[]
  streaming: string | null
  searching: boolean
  calls: number
  /** "Asking is possible right now" — App folds being online into it. */
  hasKey: boolean
  online: boolean
  onSend: (text: string) => void
  onRetry: () => void
  onNewTopic: () => void
}) {
  const [draft, setDraft] = useState('')
  const foot = useRef<HTMLDivElement>(null)
  const busy = streaming !== null

  // Follow the answer as it arrives. Skipped on the first paint so opening the
  // tab doesn't yank a restored transcript to its end before it can be read.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    // jsdom has no layout and no `scrollIntoView`; guarded the same way the
    // app guards `window.scrollTo`.
    foot.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' })
  }, [turns, streaming])

  const submit = (text: string) => {
    if (!text.trim() || busy) return
    onSend(text)
    setDraft('')
  }

  const last = turns[turns.length - 1]
  const canRetry = last?.failed === true && hasKey && !busy
  // Nothing to divide, and never two rules in a row.
  const canDivide = Boolean(last) && last.role !== 'divider' && !busy

  return (
    <div className="chat">
      {turns.length === 0 && !busy && (
        <div className="chat-openers">
          <p className="chat-intro">
            Ask about your roster, the money in the room, or news on a player. It can see the whole
            board and your draft; it searches the web only for things the board can&apos;t know.
          </p>
          {hasKey &&
            OPENERS.map((q) => (
              <button key={q} type="button" className="chat-opener" onClick={() => submit(q)}>
                {q}
              </button>
            ))}
        </div>
      )}

      <div className="chat-log">
        {turns.map((turn) =>
          turn.role === 'divider' ? (
            // A separator, not a message — it carries its label as an
            // accessible name so the rule reads as one thing rather than as a
            // stray paragraph between two answers.
            <div key={turn.id} className="chat-divider" role="separator" aria-label="New topic">
              New topic
            </div>
          ) : (
          <div
            key={turn.id}
            className={`chat-turn ${turn.role}${turn.failed ? ' failed' : ''}`}
            // Assistant turns are model output and the transcript is long
            // enough to scroll past the standing note, so each one carries the
            // attribution itself rather than relying on position.
            {...(turn.role === 'assistant' && !turn.failed ? { 'data-label': 'Claude' } : {})}
          >
            {turn.text && <p className="chat-text">{turn.text}</p>}
            {turn.searches && turn.searches.length > 0 && (
              <p className="chat-searched">Searched: {turn.searches.join(' · ')}</p>
            )}
            {turn.sources && turn.sources.length > 0 && <Sources sources={turn.sources} />}
          </div>
          ),
        )}

        {busy && (
          <div className="chat-turn assistant" data-label="Claude">
            {streaming ? (
              <p className="chat-text">{streaming}</p>
            ) : (
              <p className="chat-waiting">{searching ? 'Searching the web…' : 'Thinking…'}</p>
            )}
          </div>
        )}
        {/* Searching mid-answer: the text above has already started, so the
            spinner line belongs after it rather than replacing it. */}
        {busy && searching && streaming ? <p className="chat-waiting">Searching the web…</p> : null}

        {/* Carries a scroll-margin so following the answer doesn't park it
            under the sticky compose box. */}
        <div ref={foot} className="chat-foot" />
      </div>

      {(canRetry || canDivide) && (
        <div className="chat-actions">
          {canRetry && (
            <button type="button" className="chat-retry" onClick={onRetry}>
              Ask again
            </button>
          )}
          {/* Not gated on having a key or being online: drawing a line under a
              restored transcript is a local edit, and it is exactly what you
              want to do while waiting for the network to come back. */}
          {canDivide && (
            <button type="button" className="chat-newtopic" onClick={onNewTopic}>
              New topic
            </button>
          )}
        </div>
      )}

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault()
          submit(draft)
        }}
      >
        <input
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hasKey ? 'Ask about the draft…' : 'Add an API key in Settings'}
          disabled={!hasKey || busy}
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="send"
        />
        {/* "Send", not "Ask" — the tab is already called Ask, and two controls
            with one name is a coin flip for anything reading by label. */}
        <button type="submit" className="chat-send" disabled={!hasKey || busy || !draft.trim()}>
          Send
        </button>
      </form>

      {/*
        Status and spend, not a disclaimer. The attribution used to live here
        too and doesn't need to: every answer is labelled where it is read,
        and that label scrolls with the transcript while a standing note under
        the input is off screen for all but the last turn.

        The bare count stays, for the same reason the scout's does: a control
        that spends money keeps its meter where the button is, not in a
        settings screen nobody opens mid-draft. It no longer spells out that
        each one is billed — anyone who entered an API key knows, and a phone
        is the wrong place to say it on every render.
      */}
      <p className="chat-note">
        {!online
          ? 'Offline — questions need the network.'
          : !hasKey
            ? 'Add a Claude API key in Settings to ask questions.'
            : `${calls} question${calls === 1 ? '' : 's'} asked this draft.`}
      </p>
    </div>
  )
}
