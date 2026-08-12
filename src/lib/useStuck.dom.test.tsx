// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useState, useEffect } from 'react'
import { useStuck } from './useStuck'

const observed: Element[] = []
let trigger: ((entries: { isIntersecting: boolean }[]) => void) | null = null

class FakeObserver {
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    trigger = cb
  }
  observe(el: Element) {
    observed.push(el)
  }
  disconnect() {}
}

afterEach(() => {
  observed.length = 0
  trigger = null
  vi.unstubAllGlobals()
})

/** Mirrors App: nothing renders until an async load resolves. */
function LateMounting() {
  const [loaded, setLoaded] = useState(false)
  const { sentinel, stuck } = useStuck<HTMLDivElement>(700)

  useEffect(() => {
    Promise.resolve().then(() => setLoaded(true))
  }, [])

  if (!loaded) return <div>loading</div>
  return (
    <>
      <div ref={sentinel} data-testid="sentinel" />
      <span>{stuck ? 'deep' : 'top'}</span>
    </>
  )
}

describe('useStuck', () => {
  it('observes a sentinel that mounts after the first render', async () => {
    // Regression: the hook used a ref + an effect keyed only on the threshold.
    // On the first render the sentinel did not exist yet, the effect bailed,
    // and its deps never changed — so nothing was ever observed and the header
    // compaction and scroll-to-top button silently never fired.
    vi.stubGlobal('IntersectionObserver', FakeObserver)

    render(<LateMounting />)
    expect(await screen.findByTestId('sentinel')).toBeInTheDocument()

    expect(observed).toHaveLength(1)
    expect(observed[0]).toBe(screen.getByTestId('sentinel'))
  })

  it('flips once the sentinel leaves the expanded root', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)

    render(<LateMounting />)
    await screen.findByTestId('sentinel')
    expect(screen.getByText('top')).toBeInTheDocument()

    act(() => trigger!([{ isIntersecting: false }]))
    expect(screen.getByText('deep')).toBeInTheDocument()

    act(() => trigger!([{ isIntersecting: true }]))
    expect(screen.getByText('top')).toBeInTheDocument()
  })

  it('degrades quietly where IntersectionObserver does not exist', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)

    render(<LateMounting />)
    await screen.findByTestId('sentinel')

    // No throw, and the un-scrolled state stands.
    expect(screen.getByText('top')).toBeInTheDocument()
  })
})
