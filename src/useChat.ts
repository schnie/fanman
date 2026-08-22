import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataAdapter } from './data/adapter'
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

      // Failed turns are on screen but never sent back: the model has no use
      // for our error prose, and a rejected key would otherwise poison every
      // later question with a paragraph about a rejected key.
      const messages: ChatMessage[] = history
        .filter((t) => !t.failed)
        .slice(-HISTORY_TURNS)
        .map((t) => ({ role: t.role, text: t.text }))
      messages.push({ role: 'user', text: question })

      let text = ''
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
            setTurns((prev) => [
              ...prev,
              {
                id: nextId(),
                role: 'assistant',
                text: text.trim(),
                at: Date.now(),
                searches: delta.searches.length > 0 ? delta.searches : undefined,
                sources: delta.sources.length > 0 ? delta.sources : undefined,
              },
            ])
          }
        }
      } catch (err) {
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
        setCalls((n) => n + 1)
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

  /** Wiped with the draft — a new draft should not inherit the old one's answers. */
  const clearChat = useCallback(() => {
    turnsRef.current = []
    setTurns([])
    void adapter.saveChat([])
  }, [adapter])

  return { turns, streaming, searching, calls, send, retry, clearChat }
}
