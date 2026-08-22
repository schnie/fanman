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
 * `App.css`. There is no standing note under the transcript doing that job —
 * a label on each answer is read where the answer is, and survives scrolling
 * past it.
 */
export function ChatPane({
  turns,
  streaming,
  searching,
  hasKey,
  online,
  onSend,
  onRetry,
  onNewTopic,
}: {
  turns: ChatTurn[]
  streaming: string | null
  searching: boolean
  /**
   * Kept apart from `online` rather than folded together, because the two
   * produce different prose in the compose box and only one of them is
   * something the user can fix from Settings.
   */
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
  const canAsk = hasKey && online
  const canRetry = last?.failed === true && canAsk && !busy
  // Nothing to divide, and never two rules in a row.
  const canDivide = Boolean(last) && last.role !== 'divider' && !busy

  /**
   * The compose box says why it can't be used, because there is no longer a
   * note under it to do that — and a disabled input with a cheerful "Ask about
   * the draft…" in it is a box that looks broken rather than one that looks
   * unavailable.
   */
  const placeholder = !hasKey
    ? 'Add an API key in Settings'
    : !online
      ? 'Offline — questions need the network'
      : 'Ask about the draft…'

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
            // Assistant turns are model output, and a transcript scrolls —
            // so each one carries the attribution itself rather than relying
            // on a note pinned somewhere else in the pane.
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
            behind the fixed compose row and the tab bar under that. */}
        <div ref={foot} className="chat-foot" />
      </div>

      {canRetry && (
        <button type="button" className="chat-retry" onClick={onRetry}>
          Ask again
        </button>
      )}

      {/*
        Fixed, not sticky. Sticky put the box in normal flow until the
        transcript grew past the viewport and only then pinned it, so it sat in
        two different places depending on how much had been said and shifted
        between them as you scrolled. A compose box is chrome, like the tab bar
        under it, and chrome does not move.

        Which makes it the only thing left that can carry the state the note
        below it used to: with no key or no network there is nothing to say
        that is not better said in the box you are about to type into.
      */}
      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault()
          submit(draft)
        }}
      >
        {/*
          Always rendered, disabled when there is nothing to divide — never
          conditionally mounted. Popping it in and out would resize the input
          beside it every time the transcript went from empty to not, which is
          the same restlessness that moved this whole row off `sticky`.

          Not gated on a key or a network: drawing a line under a restored
          transcript is a local edit, and it is exactly what you want to do
          while waiting for the connection to come back.
        */}
        <button
          type="button"
          className="chat-newtopic"
          onClick={onNewTopic}
          disabled={!canDivide}
          aria-label="New topic"
          title="New topic"
        >
          +
        </button>
        <input
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          // Offline was previously enforced only inside the hook, so the box
          // took a question and swallowed it. Refusing in the UI is the same
          // rule stated where it can be seen.
          disabled={!canAsk || busy}
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="send"
        />
        {/* "Send", not "Ask" — the tab is already called Ask, and two controls
            with one name is a coin flip for anything reading by label. */}
        <button type="submit" className="chat-send" disabled={!canAsk || busy || !draft.trim()}>
          Send
        </button>
      </form>

    </div>
  )
}
