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

/**
 * Stamped into the bundle so Settings can say which build the device is on. An
 * installed home-screen app gives you no other way to tell, which is what made
 * "is it even updating?" impossible to answer from the couch.
 *
 * The timestamp also guarantees that every deploy produces different bytes, so
 * the service worker always has something to notice even for a change that
 * happens to leave the chunk hashes alone.
 */
const BUILD = `${(process.env.GITHUB_SHA ?? 'local').slice(0, 7)} · ${new Date()
  .toISOString()
  .slice(0, 16)
  .replace('T', ' ')}Z`

export default defineConfig(({ command }) => ({
  define: { __APP_BUILD__: JSON.stringify(BUILD) },
  // Dev stays at the root so the published-port URL is just localhost:5173.
  base: command === 'build' ? BASE : '/',
  plugins: [
    react(),
    VitePWA({
      // Draft state lives in localStorage and survives a reload, so taking the
      // newest code automatically is safe — and far better than being stuck on
      // a stale build on draft morning with no way to tell.
      registerType: 'autoUpdate',
      /*
       * We register the worker ourselves, in `src/lib/appUpdate.ts`, so that
       * the update check can also run when an installed app is *resumed* — the
       * event iOS gives you instead of a page load, and the reason a home-screen
       * install could sit on week-old code indefinitely. Letting the plugin also
       * inject its script would register twice and wire up two reload listeners.
       */
      injectRegister: null,
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
        /*
         * Both are normally implied by `autoUpdate`, but only while
         * `injectRegister` is left at its default — and it isn't, above. State
         * them, because the entire update story rests on them and the coupling
         * is invisible from here: without `skipWaiting` a new build sits in the
         * waiting state until every tab closes, which on a home-screen app that
         * is only ever suspended is close to never.
         */
        skipWaiting: true,
        clientsClaim: true,
        // Precache the whole shell. It's ~110KB gzipped, so there is no reason
        // to be selective — everything needed to run a draft is on the device.
        globPatterns: ['**/*.{js,css,html}'],
        // A hard refresh mid-draft must not land on a blank page.
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        // Deliberately NO runtime caching of ESPN, FPI or Anthropic *data*:
        // rankings are already cached in localStorage with a visible
        // timestamp, and a silently stale scout report would be worse than
        // none. See README.
        //
        // Images are the exception, and the reasoning inverts. A face does not
        // go stale — nobody is misled by last week's headshot — while the cost
        // of refetching is real: ESPN stamps headshots `max-age=152`, so
        // without this the board redownloads them every few minutes on venue
        // wifi. CacheFirst means we never even ask again.
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.hostname === 'a.espncdn.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'espn-images',
              expiration: {
                // A full board is ~230 faces; the headroom covers crests and a
                // scoring switch. At ~15KB each this stays a few MB.
                maxEntries: 400,
                maxAgeSeconds: 60 * 60 * 24 * 30,
                purgeOnQuotaError: true,
              },
              // 200 only, never 0: the avatars are requested with
              // `crossOrigin`, so a healthy response is never opaque, and an
              // opaque one here means something went wrong and is not worth
              // pinning for a month.
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
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
