// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAppUpdates, reinstall, type Registrar } from './appUpdate'

/**
 * A stand-in for `ServiceWorkerRegistration`. Only three members matter to
 * `check()`: the `update()` call it makes, and the two slots a newly-found
 * worker shows up in afterwards.
 */
function fakeRegistration(
  after: {
    installing?: boolean
    waiting?: boolean
    rejects?: boolean
    /** Announce a new worker and then finish activating it inside `update()`. */
    activatesDuringCheck?: boolean
  } = {},
) {
  const listeners = new Set<() => void>()
  const registration = {
    installing: null as unknown,
    waiting: null as unknown,
    addEventListener: (_type: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => void listeners.delete(fn),
    update: vi.fn(async () => {
      if (after.rejects) throw new Error('offline')
      if (after.activatesDuringCheck) listeners.forEach((fn) => fn())
      if (after.installing) registration.installing = {}
      if (after.waiting) registration.waiting = {}
    }),
  }
  return registration
}

const from = (registration: unknown): Registrar => async () =>
  registration as ServiceWorkerRegistration | undefined

/** Wake the app the way iOS does when you tap the icon on a suspended app. */
const wake = () => window.dispatchEvent(new Event('pageshow'))

afterEach(() => {
  vi.useRealTimers()
})

describe('checking for a new build', () => {
  it('reports the app is current when the server has nothing newer', async () => {
    const registration = fakeRegistration()
    const updates = createAppUpdates(from(registration), 'test')

    expect(await updates.check()).toBe('current')
    expect(registration.update).toHaveBeenCalledTimes(1)
  })

  it('reports an update once a new worker starts installing', async () => {
    const updates = createAppUpdates(from(fakeRegistration({ installing: true })), 'test')

    expect(await updates.check()).toBe('updating')
  })

  /**
   * A worker found by an earlier check has already finished installing and is
   * sitting in `waiting`. Reading only `installing` called that "current" —
   * the exact wrong answer for a device that has the new build on disk.
   */
  it('reports an update for a worker that is already waiting', async () => {
    const updates = createAppUpdates(from(fakeRegistration({ waiting: true })), 'test')

    expect(await updates.check()).toBe('updating')
  })

  /**
   * The failure that matters most. Venue wifi drops the request, and answering
   * "you're up to date" would be a guess presented as a fact — the same reason
   * rankings carry a visible timestamp instead of quietly serving stale data.
   */
  it('says it could not tell, rather than "current", when the check fails', async () => {
    const updates = createAppUpdates(from(fakeRegistration({ rejects: true })), 'test')

    expect(await updates.check()).toBe('failed')
  })

  it('reports unsupported where no worker was ever registered', async () => {
    const updates = createAppUpdates(from(undefined), 'test')

    expect(await updates.check()).toBe('unsupported')
  })

  /**
   * The window `installing`/`waiting` cannot see: skipWaiting lets a new worker
   * be found, install and activate entirely inside the `update()` call, leaving
   * both slots empty. Saying "you're on the latest build" here would be a lie
   * the page disproves a second later by reloading.
   */
  it('reports an update for a worker that activated during the check', async () => {
    const updates = createAppUpdates(from(fakeRegistration({ activatesDuringCheck: true })), 'test')

    expect(await updates.check()).toBe('updating')
  })

  /**
   * Registration is not guaranteed to settle — `npm run dev` supplies a
   * `registerSW` stub that calls neither callback. Without a timeout the first
   * check awaits forever and the button sticks on "Checking…" with no retry.
   */
  it('gives up on a registration that never arrives instead of hanging', async () => {
    vi.useFakeTimers()
    const updates = createAppUpdates(() => new Promise(() => {}), 'test')

    const result = updates.check()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await result).toBe('unsupported')
  })

  it('treats a registration that fails outright as nothing to update', async () => {
    const updates = createAppUpdates(async () => {
      throw new Error('chunk failed to load')
    }, 'test')

    expect(await updates.check()).toBe('unsupported')
  })

  it('carries the build stamp through for Settings to show', () => {
    const updates = createAppUpdates(from(undefined), 'abc1234', '2026-08-22T10:00:00.000Z')

    expect(updates.version).toBe('abc1234')
    /*
     * Untouched, deliberately: the instant crosses the seam raw so the device
     * can render it in its own timezone. Formatting here would bake in the
     * build machine's clock, which is the UTC stamp this replaced.
     */
    expect(updates.builtAt).toBe('2026-08-22T10:00:00.000Z')
  })
})

describe('checking when the app wakes up', () => {
  /**
   * The whole point of the module: iOS resumes a home-screen app without a page
   * load, so nothing keyed to load ever runs. `pageshow` is the event that does.
   */
  it('checks when a suspended app is resumed', async () => {
    const registration = fakeRegistration()
    createAppUpdates(from(registration), 'test')

    wake()
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1))
  })

  it('checks when the app becomes visible again', async () => {
    const registration = fakeRegistration()
    createAppUpdates(from(registration), 'test')

    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1))
  })

  /**
   * A single resume can fire `pageshow` and `visibilitychange` together, in the
   * same task, on an instance that has never checked before. They are one
   * wake-up and deserve one request.
   *
   * This originally fired the burst *after* an awaited first check, so the
   * throttle stamp was already written and the test passed while the real
   * scenario asked twice — the stamp was being set after `await ready`, which
   * no handler in the burst had reached yet.
   */
  it('treats the very first burst of wake-up events as a single check', async () => {
    const registration = fakeRegistration()
    createAppUpdates(from(registration), 'test')

    wake()
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1))
    expect(registration.update).toHaveBeenCalledTimes(1)
  })

  it('checks again once the throttle window has passed', async () => {
    vi.useFakeTimers()
    const registration = fakeRegistration()
    createAppUpdates(from(registration), 'test')

    wake()
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1))

    vi.setSystemTime(Date.now() + 60_000)
    wake()
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(2))
  })

  it('does not check while the app is in the background', async () => {
    const registration = fakeRegistration()
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    createAppUpdates(from(registration), 'test')

    wake()
    await Promise.resolve()
    expect(registration.update).not.toHaveBeenCalled()

    hidden.mockRestore()
  })

  /**
   * Tapping the button is an explicit request, so it ignores the throttle a
   * resume is subject to. Otherwise the one control that exists to break a
   * stuck install could itself refuse to do anything.
   */
  it('runs a manual check even inside the throttle window', async () => {
    const registration = fakeRegistration()
    const updates = createAppUpdates(from(registration), 'test')

    wake()
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1))

    expect(await updates.check()).toBe('current')
    expect(registration.update).toHaveBeenCalledTimes(2)
  })
})

describe('reinstalling the app files', () => {
  /** Stands in for the worker and cache APIs, neither of which jsdom has. */
  function stubStorage({ throws = false } = {}) {
    const unregister = vi.fn(async () => true)
    const remove = vi.fn(async () => true)
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        getRegistrations: async () => {
          if (throws) throw new Error('storage blocked')
          return [{ unregister }]
        },
      },
      configurable: true,
    })
    Object.defineProperty(globalThis, 'caches', {
      value: { keys: async () => ['shell', 'espn-images'], delete: remove },
      configurable: true,
    })
    return { unregister, remove }
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
    Reflect.deleteProperty(globalThis, 'caches')
  })

  it('drops the worker and every cache, then reloads', async () => {
    const { unregister, remove } = stubStorage()
    const reload = vi.fn()

    await reinstall(reload)

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('shell')
    expect(remove).toHaveBeenCalledWith('espn-images')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  /**
   * The draft, the settings and the API key all live in localStorage. Taking
   * them out is exactly what deleting the home-screen icon does, and the whole
   * reason this button exists is to be the version that doesn't.
   */
  it('leaves localStorage — and so the draft — completely alone', async () => {
    stubStorage()
    localStorage.setItem('fanman:draft', '{"picks":[1,2,3]}')

    await reinstall(vi.fn())

    expect(localStorage.getItem('fanman:draft')).toBe('{"picks":[1,2,3]}')
  })

  /**
   * Safari private browsing throws from these APIs. Swallowing that left the
   * confirm panel open with nothing whatsoever appearing to happen, which after
   * a destructive confirmation reads as a broken app.
   */
  it('still reloads when clearing throws, rather than failing silently', async () => {
    stubStorage({ throws: true })
    const reload = vi.fn()

    await expect(reinstall(reload)).rejects.toThrow('storage blocked')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
