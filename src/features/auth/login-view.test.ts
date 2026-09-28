/**
 * Sign-up screen vs. the auth server's own settings.
 *
 * Whether a new email sign-up can reach the app depends on one Supabase
 * setting ("Confirm email"). When it is on, an email sign-up creates an
 * account that cannot sign in, and on the default mailer the confirmation link
 * usually never arrives — the shopkeeper is stranded and the address is burned
 * for a retry. The screen must say so *before* the form is submitted, and must
 * say nothing when the setting is off.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loginView } from './login-view'
import { resetAuthSettings } from '../../app/platform/auth'
import { sessionStore } from '../../app/state/session'

/** Pretend the auth server reports this. */
function stubSettings(body: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => body,
    }))
  )
}

async function openSignUp(): Promise<HTMLElement> {
  const view = loginView({ onAuthenticated: () => undefined })
  document.body.appendChild(view)
  const toSignUp = [...view.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Create your shop')
  )
  toSignUp?.click()
  // The notice arrives from an async settings read.
  await vi.waitFor(() => {
    expect(view.querySelector('#signup-shop')).not.toBeNull()
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return view
}

beforeEach(() => {
  sessionStore.reset({
    status: 'anonymous',
    userId: null,
    email: null,
    organizations: [],
    activeOrganizationId: null,
    permissions: [],
    error: null,
  })
  resetAuthSettings()
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('sign-up and email confirmation', () => {
  it('shows the Mekholi brand on the shared login surface', () => {
    const view = loginView({ onAuthenticated: () => undefined })
    const logo = view.querySelector<HTMLImageElement>('img[alt="Mekholi logo"]')
    expect(logo?.getAttribute('src')).toBe('./icons/mekholi-192.png')
    expect(view.textContent).toContain('Mekholi')
  })

  it('warns up front when the project requires email confirmation', async () => {
    stubSettings({ mailer_autoconfirm: false, disable_signup: false })
    const view = await openSignUp()

    const notice = view.querySelector('[data-signup-notice]')
    expect(notice).not.toBeNull()
    expect(notice?.textContent).toContain('Confirm email')
    // The working alternative has to be on screen, or the warning is just bad news.
    expect(notice?.textContent).toContain('Google')
  })

  it('says nothing when the server confirms sign-ups itself', async () => {
    stubSettings({ mailer_autoconfirm: true, disable_signup: false })
    const view = await openSignUp()

    expect(view.querySelector('[data-signup-notice]')).toBeNull()
    expect(view.querySelector('#signup-shop')).not.toBeNull()
  })

  it('never blocks sign-up on a preflight that could not be answered', async () => {
    // Offline, blocked, or a gateway hiccup: the form stays silent and usable.
    // A failed preflight must not become a new way for sign-up to break.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    const view = await openSignUp()

    expect(view.querySelector('[data-signup-notice]')).toBeNull()
    expect(view.querySelector('#signup-shop')).not.toBeNull()
  })
})
