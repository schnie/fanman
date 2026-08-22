import { useCallback, useEffect, useRef } from 'react'

/** The custom property the height is published under. */
const VAR = '--head-h'

/**
 * Publishes the sticky header's height as a CSS custom property on the root
 * element, so anything *else* that pins can sit directly beneath it.
 *
 * The open row's header latches under the header stack while you scroll its
 * card (see `.row.expanded > .row-main` in App.css), and `position: sticky`
 * needs a number for `top` — CSS cannot ask another element how tall it is.
 * That height is not a constant we could hard-code: the budget bar compacts
 * once pinned, the filter chips wrap on a narrow phone, and the roster-full
 * notice appears and disappears mid-draft. Each of those changes it while the
 * page is open, so it is measured rather than assumed.
 *
 * A `ResizeObserver` rather than a resize listener: it fires on the header's
 * own layout changing, not only on the window's, and it costs nothing per
 * frame while a thumb is flinging through 230 rows.
 *
 * The value is written straight to the DOM instead of through state on
 * purpose. It changes on a scroll-driven class flip, and re-rendering the
 * whole board — every row, every avatar — to move one offset would undo the
 * memoisation those rows exist to get.
 *
 * A callback ref for the same reason as `useStuck`: the header mounts only
 * after the persisted draft loads, so an effect would run once against a null
 * ref and never look again.
 */
export function useHeadHeight<T extends HTMLElement>() {
  const observer = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect()
    observer.current = null

    if (!node) {
      // The header is gone; so is any offset that referred to it. Leaving the
      // last measurement behind would pin the next open row against a gap.
      document.documentElement.style.removeProperty(VAR)
      return
    }

    // jsdom has no ResizeObserver. Degrade to the CSS fallback, which pins the
    // row at the top of the viewport rather than throwing.
    if (typeof ResizeObserver === 'undefined') return

    const publish = () => {
      // Rounded up: half a pixel short leaves a sliver of the row below
      // showing through between the two pinned elements.
      const h = Math.ceil(node.getBoundingClientRect().height)
      document.documentElement.style.setProperty(VAR, `${h}px`)
    }

    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(node)
    observer.current = ro
  }, [])

  // The callback ref covers the node leaving the DOM, but not the component
  // being torn down around it — same shape as `useStuck`.
  useEffect(
    () => () => {
      observer.current?.disconnect()
      document.documentElement.style.removeProperty(VAR)
    },
    [],
  )

  return ref
}
