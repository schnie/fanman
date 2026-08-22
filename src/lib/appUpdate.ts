/**
 * Keeping an *installed* app on the current build.
 *
 * In a browser tab a stale build is one refresh away. A home-screen app on iOS
 * has no refresh control, and tapping its icon usually resumes a frozen page
 * rather than navigating — so the service worker's own update check, which only
 * runs on a real page load, may not fire for days. Force-quitting from the app
 * switcher is supposed to force that load and in practice often doesn't. The
 * symptom is an app simply stuck on last week's code with no way in, which on
 * draft morning is the failure `registerType: 'autoUpdate'` was chosen to
 * prevent and quietly wasn't preventing.
 *
 * The missing piece was never the update *mechanism* — autoUpdate already skips
 * waiting, claims the page and reloads it. It was the trigger. So we ask
 * explicitly: every time the app comes to the foreground, on a slow timer while
 * it sits open, and on demand from a button in Settings.
 *
 * The deliberate non-solution is deleting the home-screen icon and re-adding
 * it. That works, and it takes the draft with it — a standalone app's storage
 * goes when the icon does. Everything here exists to avoid ever needing that.
 */

/**
 * What a check found. `failed` exists so an offline check can say "I don't
 * know" instead of the much worse "you're up to date".
 */
export type UpdateCheck = 'updating' | 'current' | 'failed' | 'unsupported'

export interface AppUpdates {
  /** Which build this device is running. Settings shows it verbatim. */
  version: string
  /** Ask the server whether a newer build exists. */
  check(): Promise<UpdateCheck>
  /** Throw away the cached app and download it again. Keeps the draft. */
  reinstall(): Promise<void>
}

/**
 * How we get hold of the registration. Injected so tests can drive `check()`
 * without a real worker: jsdom has no `navigator.serviceWorker` at all, and the
 * production path imports `virtual:pwa-register`, which only exists once
 * vite-plugin-pwa has run.
 */
export type Registrar = () => Promise<ServiceWorkerRegistration | undefined>

/**
 * Wake-ups arrive in clusters — an iOS resume can fire `pageshow` and
 * `visibilitychange` together — and they are all the same wake-up. A manual tap
 * ignores this: if you pressed the button you want an answer now.
 */
const CHECK_THROTTLE_MS = 30_000

/** Backstop for an app left open on the arm of the couch all afternoon. */
const POLL_MS = 15 * 60 * 1000

/**
 * How long we wait for a registration before deciding there isn't one.
 *
 * Registration is not guaranteed to settle. `npm run dev` gets a stub for
 * `registerSW` that calls neither callback; a chunk that fails to load calls
 * neither either. Without this the first check awaits a promise that never
 * resolves, which shows up as a button stuck on "Checking…" with no way back —
 * and, because the throttle stamp is written by the check, every later wake-up
 * starting another one behind it.
 */
const REGISTER_TIMEOUT_MS = 10_000

export function createAppUpdates(
  registrar: Registrar = registerViaPlugin,
  version: string = __APP_BUILD__,
): AppUpdates {
  /*
   * Guarded here rather than inside the default registrar so the guarantee
   * belongs to the seam: whatever a registrar does, `ready` settles, and a
   * registration we never got reports `unsupported` rather than hanging.
   */
  const ready: Promise<ServiceWorkerRegistration | undefined> = Promise.race([
    registrar().catch(() => undefined),
    new Promise<undefined>((resolve) => {
      window.setTimeout(() => resolve(undefined), REGISTER_TIMEOUT_MS)
    }),
  ])
  let lastCheck = 0

  const check = async (): Promise<UpdateCheck> => {
    /*
     * Stamped synchronously, before the first `await`. An iOS resume fires
     * `pageshow` and `visibilitychange` in the same task, so if this waited for
     * the registration first, both handlers would read a stale `lastCheck`,
     * sail past the throttle and ask twice — the burst this module exists to
     * collapse.
     */
    lastCheck = Date.now()
    const registration = await ready
    if (!registration) return 'unsupported'

    /*
     * `installing`/`waiting` alone miss a real window: with `skipWaiting` the
     * new worker can be found, install and activate inside the `update()` call,
     * leaving both slots null. Reporting "you're on the latest build" moments
     * before the page reloads itself is the one answer that makes the button
     * look broken. `updatefound` fires the moment a new worker appears, so it
     * catches that window regardless of how far along it got.
     */
    let found = false
    const noteFound = () => {
      found = true
    }
    registration.addEventListener('updatefound', noteFound)
    try {
      await registration.update()
    } catch {
      // Offline, or the server is unreachable. Nothing is broken; we just don't
      // know, and guessing "current" here is how you end up trusting a stale
      // build because a button told you to.
      return 'failed'
    } finally {
      registration.removeEventListener('updatefound', noteFound)
    }
    return found || registration.installing || registration.waiting ? 'updating' : 'current'
  }

  const checkOnWake = () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastCheck < CHECK_THROTTLE_MS) return
    void check()
  }

  document.addEventListener('visibilitychange', checkOnWake)
  /*
   * The one that matters on iOS. A home-screen app resumed from the
   * back/forward cache fires `pageshow` and *not* `load`, so everything keyed
   * to page load — including the service worker's own built-in check — sits out
   * the exact moment we care about.
   */
  window.addEventListener('pageshow', checkOnWake)
  // Never cleared: this lives as long as the app does, and there is no unmount.
  window.setInterval(checkOnWake, POLL_MS)

  return { version, check, reinstall }
}

/**
 * The escape hatch, for when the check keeps insisting there is nothing new.
 *
 * Unregistering the worker and dropping every cache means the next load has to
 * come from the network — no worker left to answer it, and nothing on disk to
 * answer it from. `localStorage` is deliberately untouched: the draft, the
 * settings and the API key all live there, and taking them out is precisely
 * what makes the re-add-the-icon workaround unusable mid-draft.
 */
export async function reinstall(reload: () => void = defaultReload): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((r) => r.unregister()))
    }
    if ('caches' in globalThis) {
      // Takes the headshot cache with it. Those are free to refetch, and this is
      // the button you press when you have stopped trusting anything on the
      // device.
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  } finally {
    /*
     * In the `finally` because the storage APIs above can throw — Safari
     * private browsing, storage blocked — and swallowing that left the confirm
     * panel sitting open with nothing whatsoever having appeared to happen. A
     * reload after a partial clear is harmless; silence after a destructive
     * confirmation is not.
     */
    reload()
  }
}

/** Separated only so tests can drive `reinstall` without navigating jsdom. */
const defaultReload = () => window.location.reload()

/**
 * Imported lazily rather than at module scope so this file can be loaded — and
 * tested — without vite-plugin-pwa's virtual module existing.
 *
 * Neither callback is guaranteed to fire: the dev build's `registerSW` is a
 * stub that calls nothing at all. The timeout in `createAppUpdates` is what
 * makes that survivable, so resist "simplifying" it away.
 */
const registerViaPlugin: Registrar = async () => {
  if (!('serviceWorker' in navigator)) return undefined
  const { registerSW } = await import('virtual:pwa-register')
  return new Promise((resolve) => {
    registerSW({
      immediate: true,
      onRegisteredSW: (_url, registration) => resolve(registration),
      onRegisterError: () => resolve(undefined),
    })
  })
}
