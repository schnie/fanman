// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAppUpdates, type Registrar } from './appUpdate'

/**
 * A stand-in for `ServiceWorkerRegistration`. Only three members matter to
 * `check()`: the `update()` call it makes, and the two slots a newly-found
 * worker shows up in afterwards.
 */
function fakeRegistration(
  after: { installing?: boolean; waiting?: boolean; rejects?: boolean } = {},
) {
  const registration = {
    installing: null as unknown,
    waiting: null as unknown,
    update: vi.fn(async () => {
      if (after.rejects) throw new Error('offline')
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

  it('carries the build stamp through for Settings to show', () => {
    expect(createAppUpdates(from(undefined), 'abc1234 · 2026-08-22 10:00Z').version).toBe(
      'abc1234 · 2026-08-22 10:00Z',
    )
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
   * A single resume can fire `pageshow` and `visibilitychange` together. They
   * are one wake-up and deserve one request, not one each.
   */
  it('treats a burst of wake-up events as a single check', async () => {
    const registration = fakeRegistration()
    createAppUpdates(from(registration), 'test')

    wake()
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1))

    wake()
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
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
