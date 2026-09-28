/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activatePwaUpdate, PWA_UPDATE_READY, registerPwa } from './pwa'

function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value })
}

describe('PWA registration', () => {
  beforeEach(() => {
    secure(true)
    document.head.innerHTML = '<base href="https://example.test/Mekholi/">'
  })

  it('registers the worker at the deployment root and reports a waiting update', async () => {
    const registration = {
      waiting: { postMessage: vi.fn() },
      installing: null,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration
    const register = vi.fn().mockResolvedValue(registration)
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    registerPwa(
      { serviceWorker: { register, controller: {} } as unknown as ServiceWorkerContainer },
      window
    )
    window.dispatchEvent(new Event('load'))
    await Promise.resolve()

    expect(register).toHaveBeenCalledWith(
      new URL('https://example.test/Mekholi/sw.js'),
      { scope: '/Mekholi/' }
    )
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: PWA_UPDATE_READY }))
  })

  it('does not register outside a secure context', () => {
    secure(false)
    const register = vi.fn()
    registerPwa(
      { serviceWorker: { register } as unknown as ServiceWorkerContainer },
      window
    )
    window.dispatchEvent(new Event('load'))
    expect(register).not.toHaveBeenCalled()
  })

  it('activates a waiting update only when explicitly asked', () => {
    const postMessage = vi.fn()
    activatePwaUpdate({ waiting: { postMessage } } as unknown as ServiceWorkerRegistration)
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })
})
