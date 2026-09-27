/**
 * Which plugins actually load when the shop signs in.
 *
 * The bug this pins: Printer Setup and Barcode Scanner were moved out of the
 * core into plugins, and plugins load from `plugin_packages` — a table seeded
 * by a migration. On a database one version behind, the rows were not there,
 * so the two screens had no menu entry, no route, and the old `/printer-setup`
 * bookmark fell through the router's fallback onto the dashboard. A page for
 * configuring the shop's own printer had quietly disappeared.
 *
 * The rule now: a plugin that owns no server data and charges nothing loads
 * whatever the catalogue says, including when the catalogue cannot be read.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const state = vi.fn(async () => [] as Array<{
  key: string
  version: string
  enabled: boolean
  status: 'ok' | 'error'
  lastError: string | null
  config: Record<string, unknown>
}>)

vi.mock('./data', () => ({
  getRepositories: () => ({
    plugins: {
      state,
      dataGet: vi.fn(async () => null),
      dataSet: vi.fn(async () => undefined),
      setConfig: vi.fn(async () => ({ key: '', config: {} })),
    },
  }),
}))

const { syncPlugins, pluginRegistry, alwaysOnPlugins, SHIPPED_PLUGINS } = await import('./plugins')
const { sessionStore, EMPTY_SESSION } = await import('./state/session')

function signIn(): void {
  sessionStore.reset({
    ...EMPTY_SESSION,
    status: 'authenticated',
    userId: 'u-1',
    email: 'owner@shop.test',
    organizations: [
      {
        organization_id: 'org-1',
        name: 'Test Shop',
        slug: 'test-shop',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        role_names: ['Owner'],
        role_keys: ['owner'],
        shop_type: 'grocery',
        is_owner: true,
        permissions: ['settings.view'],
      },
    ],
    activeOrganizationId: 'org-1',
    permissions: ['settings.view'],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.mockResolvedValue([])
  signIn()
})

afterEach(async () => {
  pluginRegistry.disposeAll()
})

describe('the always-on set', () => {
  it('is exactly the hardware screens: scanner, printer, and the labels between them', () => {
    expect(alwaysOnPlugins().sort()).toEqual(['barcode-scanner', 'label-printing', 'printer-setup'])
  })

  it('never contains a plugin that charges money or owns a table', () => {
    // The whole justification for bypassing the shop's own decision is that
    // there is no decision to make: nothing to pay for, nothing stored on the
    // server. The moment that stops being true this must be a real toggle.
    for (const shipped of SHIPPED_PLUGINS.filter((entry) => entry.alwaysOn === true)) {
      expect(shipped.manifest.pricing?.priceBdt ?? 0).toBe(0)
      expect(shipped.manifest.dataOwnership).toBe('transient')
    }
  })
})

describe('syncing a shop’s plugins', () => {
  it('loads the device screens even when the catalogue has never heard of them', async () => {
    // Exactly the reported state: the server predates the migration that
    // seeds these two packages, so the shop's plugin state is empty.
    state.mockResolvedValue([])

    await syncPlugins()

    expect(pluginRegistry.loadedIds).toContain('printer-setup')
    expect(pluginRegistry.loadedIds).toContain('barcode-scanner')
  })

  it('gives them a menu entry and a route, which is what was missing', async () => {
    await syncPlugins()

    const navIds = pluginRegistry.nav.items.map((item) => item.id)
    expect(navIds).toContain('printer-setup')
    expect(navIds).toContain('barcode-scanner')

    const routes = pluginRegistry.routes.items.map((route) => route.path)
    expect(routes).toContain('/plugins/printer-setup')
    expect(routes).toContain('/plugins/barcode-scanner')
  })

  it('still loads them when the catalogue read fails outright', async () => {
    state.mockRejectedValue(new Error('offline'))

    await syncPlugins()

    expect(pluginRegistry.loadedIds).toContain('printer-setup')
    expect(pluginRegistry.loadedIds).toContain('barcode-scanner')
  })

  it('adds them to what the shop switched on, rather than replacing it', async () => {
    state.mockResolvedValue([
      { key: 'warranty', version: '1.0.0', enabled: true, status: 'ok', lastError: null, config: {} },
      { key: 'variants', version: '1.0.0', enabled: false, status: 'ok', lastError: null, config: {} },
    ])

    await syncPlugins()

    expect(pluginRegistry.loadedIds).toContain('warranty')
    expect(pluginRegistry.loadedIds).toContain('printer-setup')
    // A plugin switched off stays off — always-on is a floor, not an override.
    expect(pluginRegistry.loadedIds).not.toContain('variants')
  })

  it('unloads everything when nobody is signed in', async () => {
    await syncPlugins()
    expect(pluginRegistry.loadedIds.length).toBeGreaterThan(0)

    sessionStore.reset({ ...EMPTY_SESSION })
    await syncPlugins()

    expect(pluginRegistry.loadedIds).toEqual([])
  })
})
