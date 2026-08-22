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

export function createAppUpdates(
  registrar: Registrar = registerViaPlugin,
  version: string = __APP_BUILD__,
): AppUpdates {
  const ready = registrar()
  let lastCheck = 0

  const check = async (): Promise<UpdateCheck> => {
    const registration = await ready
    if (!registration) return 'unsupported'
    lastCheck = Date.now()
    try {
      await registration.update()
    } catch {
      // Offline, or the server is unreachable. Nothing is broken; we just don't
      // know, and guessing "current" here is how you end up trusting a stale
      // build because a button told you to.
      return 'failed'
    }
    // `update()` resolves once the check has completed. A newer worker shows up
    // as one installing, or one already waiting from an earlier check. Either
    // way autoUpdate is about to claim the page and reload it out from under
    // us, so the caller's job is only to say so.
    return registration.installing || registration.waiting ? 'updating' : 'current'
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
export async function reinstall(): Promise<void> {
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
  window.location.reload()
}

/**
 * Imported lazily rather than at module scope so this file can be loaded — and
 * tested — without vite-plugin-pwa's virtual module existing. Exactly one of
 * the two callbacks always fires, including when workbox itself fails to load.
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
