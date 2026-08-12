// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScrollTopButton } from './ScrollTopButton'

afterEach(() => vi.unstubAllGlobals())

const stubReducedMotion = (reduce: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))

describe('ScrollTopButton', () => {
  it('renders nothing until the page is scrolled far enough', () => {
    const { container } = render(<ScrollTopButton visible={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('exposes an accessible label rather than a bare icon', () => {
    render(<ScrollTopButton visible />)
    expect(screen.getByRole('button', { name: 'Scroll back to top' })).toBeInTheDocument()
  })

  it('scrolls smoothly to the top when tapped', async () => {
    stubReducedMotion(false)
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)

    await userEvent.setup().click(render(<ScrollTopButton visible />).getByRole('button'))

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('jumps without animation when the user prefers reduced motion', async () => {
    stubReducedMotion(true)
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)

    await userEvent.setup().click(render(<ScrollTopButton visible />).getByRole('button'))

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
  })

  it('still scrolls where matchMedia is unavailable', async () => {
    vi.stubGlobal('matchMedia', undefined)
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)

    await userEvent.setup().click(render(<ScrollTopButton visible />).getByRole('button'))

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})
