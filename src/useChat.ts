import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataAdapter } from './data/adapter'
import { isAccountProblem, isScoutError } from './data/scoutError'
import type { DraftContext } from './domain/chatContext'
import type { ChatMessage, ChatTurn } from './domain/types'

/**
 * How many past turns go back to the API with a new question.
 *
 * Every turn re-sends the whole draft context anyway, so history is the part
 * that grows without bound — and a draft-day question is almost always about
 * right now, not about something asked an hour ago. Six exchanges is enough
 * for "what about him instead?" to make sense and short enough that the
 * twentieth question costs what the first one did. The transcript on screen is
 * never trimmed; only what we pay to re-read is.
 */
const HISTORY_TURNS = 12

let seq = 0
function nextId(): string {
  seq += 1
  return `${Date.now()}-${seq}`
}

/**
 * The turns that go back to the API with a new question.
 *
 * Three rules, and the order they apply in is the whole of it:
 *
 * 1. A divider resets the conversation, so everything up to and including the
 *    last one is dropped.
 * 2. Failed turns never go back — the model has no use for our error prose,
 *    and a rejected key would otherwise poison every later question with a
 *    paragraph about a rejected key.
 * 3. What survives is windowed to the last `HISTORY_TURNS`.
 *
 * The window must come last. Apply it first and a divider sitting further back
 * than twelve turns falls outside the slice and silently stops working — the
 * button would look like it did something (the rule renders) while the model
 * kept reading straight through it.
 *
 * Then a fourth rule cleans up after the third: the API requires the first
 * message to be a `user` one, and the window can perfectly well cut in the
 * middle of an exchange. Alternating turns make that look impossible, but a
 * failure breaks the alternation — it appends *two* turns (the partial answer
 * and the error) and drops both, while the question that caused it survives.
 * One failure earlier in a topic is enough to make the surviving list odd, and
 * the twelve-turn slice then opens on an answer. Every question after that
 * point 400s until the user happens to start a new topic.
 *
 * Exported for its tests: these interact, and the DOM test can only reach one
 * combination at a time.
 */
export function sendableHistory(turns: ChatTurn[], limit = HISTORY_TURNS): ChatMessage[] {
  let start = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'divider') {
      start = i + 1
      break
    }
  }
  const windowed = turns
    .slice(start)
    .flatMap((t) =>
      t.role === 'divider' || t.failed || !t.text.trim()
        ? []
        : [{ role: t.role, text: t.text }],
    )
    .slice(-limit)

  // Drop a dangling answer at the head. Only ever one — what follows it is a
  // question, or there is nothing left.
  return windowed[0]?.role === 'assistant' ? windowed.slice(1) : windowed
}

/**
 * The draft chat.
 *
 * Deliberately unlike `useScout` in one way: there is no queue, no pre-warm
 * and no de-duplication, because there is nothing to de-duplicate — every
 * question is new, and none of them is speculative. What it shares is that
 * every call costs real money, so `calls` is surfaced the same way and there
 * is exactly one path that can start one.
 */
export function useChat(
  adapter: DataAdapter,
  /**
   * Called only when a message is actually sent.
   *
   * Serialising the whole board is real work — ~230 rows of string building —
   * and the answer to "what is the draft state" is only ever needed at the
   * moment a question leaves. Passing the value instead would rebuild it on
   * every pick, every keystroke in the search box, and every render that never
   * asks anything.
   */
  buildContext: () => DraftContext,
  hasKey: boolean,
  online = true,
) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  /** Partial answer as it streams. Null when nothing is in flight. */
  const [streaming, setStreaming] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [calls, setCalls] = useState(0)
  const [loaded, setLoaded] = useState(false)

  // A ref so the callback identity doesn't change every render just because
  // App rebuilt the closure.
  const contextRef = useRef(buildContext)
  useEffect(() => {
    contextRef.current = buildContext
  })

  /**
   * Guards the send path against itself. State would be a render behind — two
   * quick taps on Send both read `streaming === null` and both pay.
   */
  const busy = useRef(false)

  /**
   * The transcript, readable synchronously.
   *
   * Sending needs the history *and* has to append to it, and the obvious way
   * to get both — start the call from inside a `setTurns` updater — is a way
   * to pay twice: React may invoke an updater more than once for a single
   * update, and does so on purpose under StrictMode. Updaters stay pure; the
   * ref is how the send path reads what is already there.
   */
  const turnsRef = useRef<ChatTurn[]>([])
  useEffect(() => {
    turnsRef.current = turns
  })

  useEffect(() => {
    let cancelled = false
    adapter.loadChat().then((saved) => {
      if (cancelled) return
      setTurns(saved)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [adapter])

  useEffect(() => {
    if (!loaded) return
    void adapter.saveChat(turns)
  }, [turns, loaded, adapter])

  const run = useCallback(
    async (history: ChatTurn[], question: string) => {
      busy.current = true
      setStreaming('')
      setSearching(false)

      const messages: ChatMessage[] = sendableHistory(history)
      messages.push({ role: 'user', text: question })

      let text = ''
      // Whether the API actually answered. Drives the spend meter below.
      let answered = false
      try {
        const stream = adapter.chat({ messages, context: contextRef.current() })
        for await (const delta of stream) {
          if (delta.type === 'text') {
            text += delta.text
            setStreaming(text)
            setSearching(false)
          } else if (delta.type === 'searching') {
            setSearching(true)
          } else {
            const answer = text.trim()
            setTurns((prev) => [
              ...prev,
              answer
                ? {
                    id: nextId(),
                    role: 'assistant',
                    text: answer,
                    at: Date.now(),
                    searches: delta.searches.length > 0 ? delta.searches : undefined,
                    sources: delta.sources.length > 0 ? delta.sources : undefined,
                    truncated: delta.truncated || undefined,
                  }
                : // A turn that produced no text at all — every token spent on
                  // thinking, or a search that answered nothing. Recording it
                  // as a normal answer puts an empty bubble on screen and, worse,
                  // sends `{role:'assistant', text:''}` back next time, which the
                  // API rejects: one silent blank would break the rest of the topic.
                  {
                    id: nextId(),
                    role: 'assistant',
                    text: 'That came back empty — ask again.',
                    at: Date.now(),
                    failed: true,
                  },
            ])
            answered = true
          }
        }
      } catch (err) {
        // An account-level failure never reached the model, so it never cost
        // anything — the same call that `useScout` makes, and for the same
        // reason: this counter is labelled as money spent, and a meter that
        // counts a rejected key as a purchase is worse than no meter.
        answered = !(isScoutError(err) && isAccountProblem(err.kind))
        // Whatever streamed before the failure is kept: a half-answer that
        // stops is still worth more than a blank box, and the error sentence
        // says what to do next.
        setTurns((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text: text.trim(),
            at: Date.now(),
            failed: true,
          },
          {
            id: nextId(),
            role: 'assistant',
            text: err instanceof Error ? err.message : 'That question failed — try again',
            at: Date.now(),
            failed: true,
          },
        ])
      } finally {
        if (answered) setCalls((n) => n + 1)
        setStreaming(null)
        setSearching(false)
        busy.current = false
      }
    },
    [adapter],
  )

  const send = useCallback(
    (raw: string) => {
      const question = raw.trim()
      if (!question || busy.current || !hasKey || !online) return
      busy.current = true // claimed here, not in `run`, so a second tap in the same tick loses
      const history = turnsRef.current
      const turn: ChatTurn = { id: nextId(), role: 'user', text: question, at: Date.now() }
      turnsRef.current = [...history, turn]
      setTurns(turnsRef.current)
      void run(history, question)
    },
    [run, hasKey, online],
  )

  /**
   * Re-ask the last question, dropping the failure it produced.
   *
   * The whole draft has moved on since — that is usually *why* it is being
   * retried — so this rebuilds the context rather than replaying the call.
   */
  const retry = useCallback(() => {
    if (busy.current || !hasKey || !online) return
    const kept = [...turnsRef.current]
    while (kept.length > 0 && kept[kept.length - 1].role === 'assistant') kept.pop()
    const last = kept[kept.length - 1]
    if (!last || last.role !== 'user') return
    busy.current = true
    turnsRef.current = kept
    setTurns(kept)
    void run(kept.slice(0, -1), last.text)
  }, [run, hasKey, online])

  /**
   * Draw a line under the conversation so far.
   *
   * Deliberately not "clear the chat". The transcript on screen is the record
   * of what you have already been told and is worth scrolling back through;
   * what needs resetting is only what we re-send, and those have been separate
   * things since `HISTORY_TURNS`. So this marks the transcript rather than
   * emptying it, and costs one turn's worth of tokens on the next question
   * instead of a fresh cache write — the reference block is identical either
   * side of the line, so nothing about the cached prefix changes.
   *
   * The real win is staleness, not the tokens. Twenty turns of budget
   * arithmetic bleeding into "is this receiver hurt" is the failure this
   * exists to prevent.
   */
  const newTopic = useCallback(() => {
    if (busy.current) return
    const prev = turnsRef.current
    // Nothing to divide, or the line is already the last thing there.
    if (prev.length === 0 || prev[prev.length - 1].role === 'divider') return
    turnsRef.current = [...prev, { id: nextId(), role: 'divider', text: '', at: Date.now() }]
    setTurns(turnsRef.current)
  }, [])

  /** Wiped with the draft — a new draft should not inherit the old one's answers. */
  const clearChat = useCallback(() => {
    turnsRef.current = []
    setTurns([])
    void adapter.saveChat([])
  }, [adapter])

  return { turns, streaming, searching, calls, send, retry, newTopic, clearChat }
}
