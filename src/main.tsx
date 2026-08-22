import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { createAppUpdates } from './lib/appUpdate.ts'

/*
 * Registers the service worker and starts asking for updates, at module scope
 * so it happens once regardless of what React does. Built here rather than
 * inside `App` for the same reason the adapter is injected: a Wails shell has
 * no service worker to register, and `App` renders without this just fine.
 */
const updates = createAppUpdates()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App updates={updates} />
  </StrictMode>,
)
