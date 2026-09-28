/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activatePwaUpdate,
  mountPwaInstallNotice,
  PWA_UPDATE_READY,
  registerPwa,
} from './pwa'

function secure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value })
}

describe('PWA registration', () => {
  beforeEach(() => {
    secure(true)
    document.head.innerHTML = '<base href="https://example.test/Mekholi/">'
    document.body.innerHTML = ''
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it('shows a one-click notice and invokes the native install prompt', async () => {
    const prompt = vi.fn().mockResolvedValue(undefined)
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    })
    const unmount = mountPwaInstallNotice({ fallbackDelayMs: 60_000 })

    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    const notice = document.querySelector('#pwa-install-notice') as HTMLElement
    expect(notice.textContent).toContain('Install Mekholi')
    expect(notice.classList).toContain('bg-surface-raised')
    expect(notice.querySelector<HTMLImageElement>('img[alt="Mekholi logo"]')?.src).toContain('/icons/mekholi-192.png')

    ;(notice.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledOnce()
      expect(document.querySelector('#pwa-install-notice')).toBeNull()
      expect(localStorage.getItem('mekholi.pwa.installed')).toBe('1')
    })
    unmount()
  })

  it('shows browser-menu guidance when no native prompt is exposed', () => {
    vi.useFakeTimers()
    const unmount = mountPwaInstallNotice({ fallbackDelayMs: 3_000 })
    vi.advanceTimersByTime(3_000)

    const notice = document.querySelector('#pwa-install-notice')
    expect(notice?.textContent).toContain('browser menu')
    expect(notice?.textContent).toContain('Not now')
    unmount()
  })

  it('never shows the notice when running as an installed app', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    })
    vi.useFakeTimers()
    const unmount = mountPwaInstallNotice({ fallbackDelayMs: 0 })
    vi.runAllTimers()

    expect(document.querySelector('#pwa-install-notice')).toBeNull()
    expect(localStorage.getItem('mekholi.pwa.installed')).toBe('1')
    unmount()
  })

  it('snoozes a dismissed notice for seven days', () => {
    vi.useFakeTimers()
    const now = vi.fn().mockReturnValue(1_000)
    const unmount = mountPwaInstallNotice({ fallbackDelayMs: 0, now })
    vi.runAllTimers()
    ;(document.querySelector('[aria-label="Dismiss install notice for seven days"]') as HTMLButtonElement).click()
    unmount()

    const second = mountPwaInstallNotice({ fallbackDelayMs: 0, now })
    vi.runAllTimers()
    expect(document.querySelector('#pwa-install-notice')).toBeNull()
    second()
  })
})
