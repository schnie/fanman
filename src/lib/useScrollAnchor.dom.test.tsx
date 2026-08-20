// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useScrollAnchor } from './useScrollAnchor'

/**
 * jsdom has no layout, so every rect is zero and the hook would measure no
 * drift at all. This stands in for one: a map of row id to viewport top that
 * the component rewrites as the accordion opens and closes, which is exactly
 * the thing the browser would be doing.
 */
const TOP: Record<string, number> = {}
const scrollBy = vi.fn()

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const id = (this as HTMLElement).dataset.rowAnchor
    return { top: id === undefined ? 0 : (TOP[id] ?? 0) } as DOMRect
  })
  vi.stubGlobal('scrollBy', scrollBy)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  scrollBy.mockReset()
})

/**
 * Two rows. Row 55 is the taller one when open, and it sits above row 56 — so
 * closing it lifts row 56 by 300px, the case the hook exists for.
 */
function Accordion({ initial }: { initial: number | null }) {
  const [openId, setOpenId] = useState<number | null>(initial)
  const anchorRow = useScrollAnchor(openId)

  // Written during render on purpose: it has to be true of the *new* layout by
  // the time the layout effect measures, and stale by the time the next tap
  // reads it. That is the order a real browser would produce.
  TOP['55'] = 100
  TOP['56'] = openId === 55 ? 500 : 200

  return (
    <ul>
      {[55, 56].map((id) => (
        <li key={id} data-row-anchor={id}>
          <button
            onClick={() => {
              anchorRow(id)
              setOpenId((cur) => (cur === id ? null : id))
            }}
          >
            row {id}
          </button>
        </li>
      ))}
    </ul>
  )
}

describe('useScrollAnchor', () => {
  it('holds the tapped row still when the row closing above it collapses', async () => {
    const user = userEvent.setup()
    render(<Accordion initial={55} />)

    // Row 56 is at y=500 under the open row 55, and lands at y=200 once 55
    // closes. Without the correction the header would leap 300px up the screen.
    await user.click(screen.getByRole('button', { name: 'row 56' }))

    expect(scrollBy).toHaveBeenCalledWith(0, -300)
  })

  it('does not scroll when the tapped row was never going to move', async () => {
    const user = userEvent.setup()
    render(<Accordion initial={56} />)

    // Opening a row *above* the open one is the case that already felt right:
    // everything that disappears was below it, so it stays at y=100.
    await user.click(screen.getByRole('button', { name: 'row 55' }))

    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('ignores sub-pixel drift rather than buying a reflow for it', async () => {
    // A row that shifts by a fraction of a pixel — rounding, not movement.
    function Jitter() {
      const [openId, setOpenId] = useState<number | null>(55)
      const anchorRow = useScrollAnchor(openId)
      TOP['55'] = openId === 55 ? 100 : 100.4
      return (
        <>
          <li data-row-anchor={55} />
          <button
            onClick={() => {
              anchorRow(55)
              setOpenId((cur) => (cur === 55 ? null : 55))
            }}
          >
            toggle
          </button>
        </>
      )
    }

    const user = userEvent.setup()
    render(<Jitter />)
    await user.click(screen.getByRole('button', { name: 'toggle' }))

    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('does nothing on a change it never anchored', async () => {
    // The accordion can also be closed from elsewhere — un-marking a player
    // does it. A leftover anchor applied to that would scroll the page for a
    // reason the user could not connect to anything they touched.
    function Elsewhere() {
      const [openId, setOpenId] = useState<number | null>(55)
      useScrollAnchor(openId)
      TOP['55'] = openId === 55 ? 100 : 900
      return (
        <>
          <li data-row-anchor={55} />
          <button onClick={() => setOpenId(null)}>close from elsewhere</button>
        </>
      )
    }

    const user = userEvent.setup()
    render(<Elsewhere />)
    await user.click(screen.getByRole('button', { name: 'close from elsewhere' }))

    expect(scrollBy).not.toHaveBeenCalled()
  })
})
