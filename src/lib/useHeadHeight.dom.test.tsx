// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { useHeadHeight } from './useHeadHeight'

let notify: (() => void) | null = null
const observed: Element[] = []

class FakeResizeObserver {
  constructor(cb: () => void) {
    notify = cb
  }
  observe(el: Element) {
    observed.push(el)
  }
  disconnect() {}
}

/** Height jsdom will report for any element — it measures nothing on its own. */
let height = 0
const realRect = HTMLElement.prototype.getBoundingClientRect

afterEach(() => {
  notify = null
  observed.length = 0
  height = 0
  HTMLElement.prototype.getBoundingClientRect = realRect
  document.documentElement.style.removeProperty('--head-h')
  vi.unstubAllGlobals()
})

function measuring(px: number) {
  height = px
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { ...realRect.call(this), height } as DOMRect
  }
}

/** Mirrors App: the header mounts only once the persisted draft has loaded. */
function LateMounting() {
  const [loaded, setLoaded] = useState(false)
  const ref = useHeadHeight<HTMLDivElement>()

  useEffect(() => {
    Promise.resolve().then(() => setLoaded(true))
  }, [])

  if (!loaded) return <div>loading</div>
  return <div ref={ref} data-testid="head" />
}

const published = () => document.documentElement.style.getPropertyValue('--head-h')

describe('useHeadHeight', () => {
  it('publishes the height of a header that mounts after the first render', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    measuring(131.2)

    render(<LateMounting />)
    const head = await screen.findByTestId('head')

    expect(observed).toEqual([head])
    // Rounded up — a fraction short shows a sliver of the row underneath.
    expect(published()).toBe('132px')
  })

  it('republishes when the header changes height', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    measuring(160)

    render(<LateMounting />)
    await screen.findByTestId('head')
    expect(published()).toBe('160px')

    // What the compact state, a wrapped filter row, or the roster-full notice
    // each do mid-draft.
    height = 104
    act(() => notify!())
    expect(published()).toBe('104px')
  })

  it('clears the offset when the header goes away', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    measuring(120)

    const { unmount } = render(<LateMounting />)
    await screen.findByTestId('head')
    expect(published()).toBe('120px')

    // A stale measurement would pin the next open row against a gap.
    unmount()
    expect(published()).toBe('')
  })

  it('degrades quietly where ResizeObserver does not exist', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    measuring(120)

    render(<LateMounting />)
    await screen.findByTestId('head')

    // No throw, and no offset — the sheet falls back to the pre-pinning
    // behaviour rather than pinning the header somewhere it cannot be read.
    expect(published()).toBe('')
  })
})
