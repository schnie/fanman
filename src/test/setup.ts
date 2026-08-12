import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library only auto-registers cleanup when vitest runs with
// `globals: true`. We don't, so unmount explicitly — otherwise each render
// stacks another copy of the board in the document and queries go ambiguous.
afterEach(cleanup)
