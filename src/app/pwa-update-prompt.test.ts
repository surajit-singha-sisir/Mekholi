/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPwaUpdatePrompt } from './pwa-update-prompt'
import { PWA_UPDATE_READY } from './pwa'

/** A minimal serviceWorker container that records controllerchange listeners. */
function fakeContainer(): {
  serviceWorker: Pick<Navigator, 'serviceWorker'>['serviceWorker']
  fireControllerChange: () => void
} {
  const listeners = new Set<() => void>()
  const serviceWorker = {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'controllerchange') listeners.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === 'controllerchange') listeners.delete(fn)
    },
  } as unknown as Pick<Navigator, 'serviceWorker'>['serviceWorker']
  return {
    serviceWorker,
    fireControllerChange: () => listeners.forEach((fn) => fn()),
  }
}

function readyEvent(registration: unknown): CustomEvent {
  return new CustomEvent(PWA_UPDATE_READY, { detail: registration })
}

afterEach(() => vi.restoreAllMocks())

describe('PWA update prompt', () => {
  it('shows a notice when an update is ready and activates it on reload', () => {
    const { serviceWorker } = fakeContainer()
    const activate = vi.fn()
    let reloadHandler: () => void = () => {}
    const notify = vi.fn((onReload: () => void) => {
      reloadHandler = onReload
      return () => {}
    })
    const registration = { waiting: { postMessage: vi.fn() } }

    mountPwaUpdatePrompt({
      windowLike: window,
      navigatorLike: { serviceWorker },
      notify,
      activate,
      reload: vi.fn(),
    })

    window.dispatchEvent(readyEvent(registration))
    expect(notify).toHaveBeenCalledTimes(1)

    // Tapping "Reload" tells the waiting worker to take over.
    reloadHandler()
    expect(activate).toHaveBeenCalledWith(registration)
  })

  it('reloads once when the new worker takes control', () => {
    const { serviceWorker, fireControllerChange } = fakeContainer()
    const reload = vi.fn()

    mountPwaUpdatePrompt({
      windowLike: window,
      navigatorLike: { serviceWorker },
      notify: () => () => {},
      reload,
    })

    fireControllerChange()
    fireControllerChange() // a second event must not reload again
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('replaces an earlier notice instead of stacking a second', () => {
    const { serviceWorker } = fakeContainer()
    const dismissals: number[] = []
    let n = 0
    const notify = vi.fn(() => {
      const id = n++
      return () => dismissals.push(id)
    })

    mountPwaUpdatePrompt({
      windowLike: window,
      navigatorLike: { serviceWorker },
      notify,
      activate: vi.fn(),
      reload: vi.fn(),
    })

    window.dispatchEvent(readyEvent({ waiting: { postMessage: vi.fn() } }))
    window.dispatchEvent(readyEvent({ waiting: { postMessage: vi.fn() } }))

    expect(notify).toHaveBeenCalledTimes(2)
    // The first notice was dismissed before the second went up.
    expect(dismissals).toEqual([0])
  })

  it('is a no-op where service workers are unavailable', () => {
    const teardown = mountPwaUpdatePrompt({
      windowLike: window,
      navigatorLike: {} as Pick<Navigator, 'serviceWorker'>,
    })
    expect(teardown).toBeTypeOf('function')
    // Tearing down must not throw even though nothing was wired.
    expect(() => teardown()).not.toThrow()
  })
})
