import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * True once the page has scrolled `afterPx` past the sentinel.
 *
 * Uses a sentinel + IntersectionObserver rather than a scroll listener, so it
 * costs nothing per frame while the user flings through 300 players.
 *
 * `sentinel` is a **callback ref**, not an object ref, and that is load-bearing:
 * the component mounts its sentinel only after an async load resolves. An
 * effect keyed on the threshold would run once against a null ref, bail, and
 * never re-run — silently observing nothing. A callback ref instead fires at
 * the moment the node enters or leaves the DOM.
 */
export function useStuck<T extends HTMLElement>(afterPx = 56) {
  const [stuck, setStuck] = useState(false)
  const observer = useRef<IntersectionObserver | null>(null)

  const sentinel = useCallback(
    (node: T | null) => {
      observer.current?.disconnect()
      observer.current = null

      // jsdom (and very old browsers) have no IntersectionObserver — degrade to
      // the un-scrolled state rather than throwing.
      if (!node || typeof IntersectionObserver === 'undefined') return

      const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
        // Growing the root's top edge keeps the sentinel "visible" until the
        // page has scrolled `afterPx`, so the state flips on a deliberate
        // scroll rather than on the first pixel of movement.
        rootMargin: `${afterPx}px 0px 0px 0px`,
        threshold: 0,
      })
      io.observe(node)
      observer.current = io
    },
    [afterPx],
  )

  // The callback ref handles unmount, but not the component being torn down
  // while the node is still attached.
  useEffect(() => () => observer.current?.disconnect(), [])

  return { sentinel, stuck }
}
