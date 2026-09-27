/**
 * The composition root, tested where composition belongs.
 *
 * A plugin may not import another plugin (spec §51) — the two shipped plugins
 * prove that by each reaching the host only through the `PluginAPI`. Which
 * means the question "do these two, as shipped, fit together?" has no home
 * inside either of them. It has this one: the app layer declares what the
 * bundle ships, so the app layer is where the declared set is checked.
 *
 * These are the facts that would otherwise be discovered by a shopkeeper:
 * a dependency naming a plugin nobody ships, two plugins minting the same
 * permission key, a manifest that fails validation at import time.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterAll } from 'vitest'
import { SHIPPED_PLUGINS, declareShippedPlugins, pluginRegistry, rememberConfig } from './plugins'
import { LICENCE_KEY, startSubscription } from '../shared/registry/plugin-licence'
import { validateManifest } from '../shared/registry/plugin-manifest'

const manifests = SHIPPED_PLUGINS.map((shipped) => shipped.manifest)
const ids = manifests.map((manifest) => manifest.id)

describe('what this bundle ships', () => {
  it('ships plugins whose manifests all validate', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(2)

    const problems = manifests
      .map((manifest) => {
        try {
          validateManifest(manifest)
          return null
        } catch (error) {
          return `${manifest.id}: ${(error as Error).message}`
        }
      })
      .filter((problem): problem is string => problem !== null)

    expect(problems).toEqual([])
    expect(declareShippedPlugins()).toEqual([])
  })

  it('declares each plugin once, with a unique permission namespace', () => {
    expect(new Set(ids).size).toBe(ids.length)

    const keys = manifests.flatMap((manifest) =>
      (manifest.permissions ?? []).map((permission) => permission.key)
    )
    expect(new Set(keys).size).toBe(keys.length)
    for (const manifest of manifests) {
      for (const permission of manifest.permissions ?? []) {
        expect(permission.key.startsWith(`${manifest.id}.`)).toBe(true)
      }
    }
  })

  it('only depends on plugins this bundle also ships', () => {
    // The one thing two plugins cannot check about each other from inside
    // themselves: that the dependency actually exists in the bundle.
    const unknown = manifests.flatMap((manifest) =>
      (manifest.dependencies ?? [])
        .filter((dependency) => !ids.includes(dependency))
        .map((dependency) => `${manifest.id} depends on ${dependency}`)
    )

    expect(unknown).toEqual([])
  })

  it('agrees with itself about versions and the core API', () => {
    for (const manifest of manifests) {
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(manifest.coreApiVersion).toMatch(/[\d*^~>]/)
    }
  })
})

describe('what a plugin costs', () => {
  it('prices every plugin, and keeps the four that must stay free free', () => {
    // Warranty: a shop should be able to keep a promise without paying for
    // the privilege. Printer Setup and Barcode Scanner: they configure
    // hardware the shop already owns, and they were core until the bundle
    // grew too heavy to carry them for the shops that print nothing —
    // charging for what used to be included would be a bait and switch.
    // Label Printing: paper for that same scanner — charging for the label
    // is charging for the scanner working.
    const free = manifests.filter((manifest) => (manifest.pricing?.priceBdt ?? 0) === 0)
    expect(free.map((manifest) => manifest.id).sort()).toEqual([
      'barcode-scanner',
      'bd-vat',
      'label-printing',
      'printer-setup',
      'warranty',
    ])
    for (const manifest of manifests) {
      // Every plugin states its price. A price that is implied is a price
      // that gets argued about later.
      expect(manifest.pricing).toBeDefined()
      if (!free.includes(manifest)) expect(manifest.pricing!.priceBdt).toBeGreaterThan(0)
    }
  })

  it('refuses to load a paid plugin this shop has not subscribed to', async () => {
    rememberConfig('variants', {})
    await pluginRegistry.sync(['variants'])

    expect(pluginRegistry.loadedIds).not.toContain('variants')
    expect(pluginRegistry.get('variants')?.status).toBe('blocked')
    expect(pluginRegistry.get('variants')?.error).toContain('৳249/month')
    await pluginRegistry.sync([])
  })

  it('loads the free one with no licence at all', async () => {
    rememberConfig('warranty', {})
    await pluginRegistry.sync(['warranty'])
    expect(pluginRegistry.loadedIds).toContain('warranty')
    await pluginRegistry.sync([])
  })

  it('stops loading a paid plugin once the trial has run out', async () => {
    const longAgo = new Date(Date.now() - 60 * 86_400_000)
    rememberConfig('variants', {
      [LICENCE_KEY]: {
        plan: 'trial',
        startedAt: longAgo.toISOString(),
        expiresAt: new Date(longAgo.getTime() + 14 * 86_400_000).toISOString(),
      },
    })
    await pluginRegistry.sync(['variants'])

    expect(pluginRegistry.loadedIds).not.toContain('variants')
    expect(pluginRegistry.get('variants')?.error).toContain('trial ended')
    await pluginRegistry.sync([])
  })
})

describe('the host, loading the shipped set', () => {
  afterAll(async () => {
    // The registry is a singleton for the app's lifetime; a test that leaves
    // plugins loaded would leak into the next file that imports it.
    await pluginRegistry.sync([])
  })

  it('knows every shipped plugin before loading any of them', () => {
    const declared = pluginRegistry.list().map((registration) => registration.id)
    for (const id of ids) expect(declared).toContain(id)
  })

  it('loads a plugin and its dependency together, through the real modules', async () => {
    // Both are paid, and the engine will not load a plugin this shop is not
    // entitled to — so the shop "subscribes" first, exactly as the Plugins
    // screen does.
    rememberConfig('loyalty-lite', { [LICENCE_KEY]: startSubscription() })
    rememberConfig('batch-expiry', { [LICENCE_KEY]: startSubscription() })
    await pluginRegistry.sync(['loyalty-lite'])

    expect(pluginRegistry.loadedIds).toEqual(['batch-expiry', 'loyalty-lite'])
    expect(pluginRegistry.resolution?.autoEnabled).toEqual(['batch-expiry'])

    // Both plugins reached the host, so both contributed what they describe.
    const sources = new Set(pluginRegistry.nav.items.map((item) => item.source))
    expect(sources.has('batch-expiry')).toBe(true)
    expect(sources.has('loyalty-lite')).toBe(true)
  })

  it('leaves nothing behind when the shop switches everything off', async () => {
    await pluginRegistry.sync([])

    expect(pluginRegistry.loadedIds).toEqual([])
    expect(pluginRegistry.nav.items).toEqual([])
    expect(pluginRegistry.widgets.items).toEqual([])
    expect(pluginRegistry.posPanels.items).toEqual([])
    expect(pluginRegistry.saleTabs.items).toEqual([])
    expect(pluginRegistry.formSections.items).toEqual([])
  })
})
