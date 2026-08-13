/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * GitHub Pages serves a project site from a subpath (`/<repo>/`), so the build
 * needs a matching base or every asset 404s. Override for a user page or a
 * custom domain with `VITE_BASE=/`.
 */
const BASE = process.env.VITE_BASE ?? '/fanman/'

export default defineConfig(({ command }) => ({
  // Dev stays at the root so the published-port URL is just localhost:5173.
  base: command === 'build' ? BASE : '/',
  plugins: [
    react(),
    VitePWA({
      // Draft state lives in localStorage and survives a reload, so taking the
      // newest code automatically is safe — and far better than being stuck on
      // a stale build on draft morning with no way to tell.
      registerType: 'autoUpdate',
      // The plugin precaches the manifest and its icons itself, so the glob
      // below must NOT also claim svg/webmanifest or they get double-entered.
      // favicon.svg is only referenced from index.html, so name it here.
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Fanman — Auction Draft',
        short_name: 'Fanman',
        description: 'Live auction draft board with budget and max-bid tracking.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0d1117',
        theme_color: '#0d1117',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the whole shell. It's ~110KB gzipped, so there is no reason
        // to be selective — everything needed to run a draft is on the device.
        globPatterns: ['**/*.{js,css,html}'],
        // A hard refresh mid-draft must not land on a blank page.
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        // Deliberately NO runtime caching for ESPN, FPI or Anthropic:
        // rankings are already cached in localStorage with a visible
        // timestamp, and a silently stale scout report would be worse than
        // none. See README.
      },
      devOptions: {
        // Keep the service worker out of the way while developing.
        enabled: false,
      },
    }),
  ],
  server: {
    // Bind every interface, not just loopback: inside a sandbox or container
    // the host can only reach us via eth0. `strictPort` matters because the
    // published port mapping is fixed — silently falling back to 5174 would
    // leave the host pointing at nothing.
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
  },
  test: {
    // Domain tests run in node; component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock at the top of the file.
    setupFiles: ['./src/test/setup.ts'],
    // `.claude/worktrees/*` holds full checkouts of this repo. Without this,
    // vitest runs a second, stale copy of the entire suite — inflating the
    // count and reporting passes from code that isn't the code being changed.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
}))
