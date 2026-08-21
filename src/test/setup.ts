import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library only auto-registers cleanup when vitest runs with
// `globals: true`. We don't, so unmount explicitly — otherwise each render
// stacks another copy of the board in the document and queries go ambiguous.
afterEach(cleanup)

// jsdom has no layout, so its `scrollTo` is a stub that reports itself to the
// virtual console — and the app now calls it on every tab switch, which buried
// the run's output under dozens of "Not implemented" lines. Real jsdom errors
// are worth seeing, so silence this one specifically rather than the channel.
// Tests that care what we scrolled to still `vi.stubGlobal('scrollTo', …)`
// over the top of this; the node-environment files have no `window` at all.
if (typeof window !== 'undefined') window.scrollTo = () => {}
