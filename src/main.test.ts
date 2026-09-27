/**
 * Boot smoke test.
 *
 * This imports the real `main.ts` in a DOM and asserts the application comes
 * up. It is the only check that proves the wiring works end to end: a valid
 * module graph (which `vite build` already proves) says nothing about whether
 * the bootstrap sequence actually runs, whether the plugin registers its
 * fields before the first render, or whether the login screen appears.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/** Wait for the bootstrap promise chain to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('application bootstrap', () => {
  let root: HTMLElement

  beforeAll(async () => {
    root = document.createElement('div')
    root.id = 'app'
    document.body.appendChild(root)

    // The Supabase env vars are absent in tests, so the app takes the
    // "not configured" path and then renders the login screen.
    await import('./main')
    await settle()
  })

  afterAll(() => {
    vi.resetModules()
  })

  it('mounts something into #app', () => {
    expect(root.children.length).toBeGreaterThan(0)
    expect(root.textContent?.length ?? 0).toBeGreaterThan(0)
  })

  /**
   * The band of empty white below the app.
   *
   * The shell is exactly one viewport tall and every region inside it scrolls
   * on its own, so the *document* must never scroll: when it did, the page
   * grew past the shell and the overshoot rendered as blank space under the
   * sidebar. Signed out, the lock must be gone again or a login form on a
   * short phone cannot be reached.
   */
  it('does not lock the page while the login screen is showing', () => {
    expect(document.body.classList.contains('app-locked')).toBe(false)
  })

  it('declares every plugin this bundle ships', () => {
    const registry = window.mekholi?.registry
    expect(registry).toBeDefined()

    const ids = (registry?.list() ?? []).map((entry) => entry.id).sort()
    expect(ids).toEqual([
      'barcode-scanner',
      'batch-expiry',
      'bd-vat',
      'due-ledger',
      'label-printing',
      'loyalty',
      'loyalty-lite',
      'printer-setup',
      'serial-numbers',
      'variants',
      'warranty',
      'weight-scale',
    ])
  })

  it('leaves plugins disabled until a shop enables them', () => {
    // Without Supabase there is no shop and therefore no plugin state: the
    // app must still come up, with core screens and no plugin surfaces.
    const registry = window.mekholi?.registry
    const statuses = (registry?.list() ?? []).map((entry) => entry.status)
    expect(statuses.every((status) => status === 'disabled')).toBe(true)
  })

  it('keeps plugin product fields out of the form until the plugin is on', () => {
    const keys = (window.mekholi?.registry.productFields.items ?? []).map((f) => f.key)
    expect(keys).toHaveLength(0)
  })

  it('keeps plugin navigation out of the sidebar until the plugin is on', () => {
    const nav = window.mekholi?.registry.nav.items ?? []
    expect(nav.find((item) => item.id === 'batch-expiry')).toBeUndefined()
  })

  it('renders the login screen when there is no session', () => {
    const status = window.mekholi?.session.state.status
    expect(status).toBe('anonymous')

    // The login card's heading.
    expect(root.textContent).toContain('Sign in')
  })

  /**
   * The hardware pages moved to `/plugins/…` when they became plugins. The
   * router sends an unknown path to the dashboard, so the old addresses —
   * printed in notes to staff, saved as bookmarks, and linked from the
   * "set up the printer first" toast for months — resolved to the dashboard
   * with no explanation. A move is not a deletion.
   */
  it('forwards the old hardware URLs to their plugin screens', async () => {
    const router = window.mekholi!.router

    await router.navigate('/printer-setup')
    await settle()
    expect(router.currentContext?.path).toBe('/plugins/printer-setup')

    await router.navigate('/scanner-setup')
    await settle()
    expect(router.currentContext?.path).toBe('/plugins/barcode-scanner')
  })

  it('exposes the diagnostics handle', () => {
    expect(window.mekholi?.bus).toBeDefined()
    expect(window.mekholi?.session).toBeDefined()
    expect(window.mekholi?.router).toBeDefined()
  })
})
