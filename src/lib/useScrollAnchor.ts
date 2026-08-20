import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * The attribute the anchor is found by. Rows carry it; nothing else should.
 */
const ANCHOR = 'data-row-anchor'

/**
 * Keeps the row you tapped exactly where it was on screen while the accordion
 * swaps which row is open.
 *
 * Only one row is open at a time, so opening a new one first closes the old
 * one — and the direction that closing happens in decides whether the tap
 * holds still. Close a row that sits *below* the tap and nothing above it
 * moves, which is why opening a row above the current one already feels right.
 * Close one that sits *above* the tap and a few hundred pixels vanish from
 * above it: everything below jumps up by that much, and the header you just
 * touched can end up off the top of the screen entirely.
 *
 * So: measure the tapped row before the state change, measure it again once
 * the DOM has caught up, and scroll by the difference. That makes the second
 * case behave like the first, whichever way you move through the list.
 *
 * The correction has to run in a layout effect. That fires after React has
 * mutated the DOM but *before* the browser paints, so the scroll lands in the
 * same frame as the reflow that caused it and is never visible as a jump.
 *
 * There is nothing native to lean on here: Safari — the browser this actually
 * ships to — has never implemented `overflow-anchor`, and the scroll anchoring
 * other engines do on their own picks its own anchor element rather than the
 * one under your thumb.
 *
 * `key` is whatever changes when the accordion moves, i.e. the open row's id.
 */
export function useScrollAnchor(key: unknown) {
  const held = useRef<{ id: number; top: number } | null>(null)

  /**
   * Call in the tap handler with the id being toggled, *before* setting state —
   * this has to read the old layout.
   */
  const anchorTo = useCallback((id: number) => {
    const el = rowEl(id)
    held.current = el ? { id, top: el.getBoundingClientRect().top } : null
  }, [])

  useLayoutEffect(() => {
    const from = held.current
    // Cleared unconditionally: a stale anchor applied to a later, unrelated
    // change would scroll the page for no reason the user can connect to.
    held.current = null
    if (!from) return

    const el = rowEl(from.id)
    // jsdom has no scrolling, and neither does a row that just unmounted.
    if (!el || typeof window.scrollBy !== 'function') return

    const drift = el.getBoundingClientRect().top - from.top
    // Sub-pixel drift is measurement noise; correcting it buys a reflow and
    // nothing a person could see.
    if (Math.abs(drift) < 1) return

    // Clamped at the very top and bottom of the document, where the page
    // simply cannot move any further. That reads as hitting the end of the
    // list rather than as a jump, so it is left alone.
    window.scrollBy(0, drift)
  }, [key])

  return anchorTo
}

function rowEl(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${ANCHOR}="${id}"]`)
}
