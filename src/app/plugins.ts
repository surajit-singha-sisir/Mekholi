/**
 * The plugin host, as the app uses it (docs/05 §4-§6).
 *
 * One module owns the registry singleton, because three distant places need
 * it and none of them should import the entry point:
 *
 *   * `main.ts` — declares what this bundle ships and syncs on sign-in;
 *   * the Plugins screen — reads the same registry to show what is loaded;
 *   * plugin-contributed surfaces (product form sections, POS panels, sale
 *     tabs, dashboard widgets) — read their slots through it.
 *
 * Declaring is deliberately separate from loading. Manifests are tiny plain
 * objects, so the app knows the shape of every plugin it ships without running
 * a line of a disabled plugin's code; `load` is a dynamic import that the
 * registry calls only for the plugins this shop has enabled.
 */

import { eventBus } from '../shared/bus'
import { PluginRegistry, type PluginHostServices } from '../shared/registry/plugin-registry'
import type {
  PluginDataStore,
  PluginSettings,
  ShippedPlugin,
} from '../shared/registry/plugin-types'
import { barcodeScannerManifest } from '../plugins/barcode-scanner/manifest'
import { bdVatManifest } from '../plugins/bd-vat/manifest'
import { dueLedgerManifest } from '../plugins/due-ledger/manifest'
import { batchExpiryManifest } from '../plugins/batch-expiry/manifest'
import { labelPrintingManifest } from '../plugins/label-printing/manifest'
import { loyaltyManifest } from '../plugins/loyalty/manifest'
import { loyaltyLiteManifest } from '../plugins/loyalty-lite/manifest'
import { printerSetupManifest } from '../plugins/printer-setup/manifest'
import { serialNumbersManifest } from '../plugins/serial-numbers/manifest'
import { variantsManifest } from '../plugins/variants/manifest'
import { warrantyManifest } from '../plugins/warranty/manifest'
import { weightScaleManifest } from '../plugins/weight-scale/manifest'
import { sessionStore } from './state/session'
import { getRepositories } from './data'

/** Settings values, per plugin, for the current shop. */
const configs = new Map<string, Record<string, unknown>>()

const organization = (): string => sessionStore.state.activeOrganizationId ?? ''

function settingsFor(pluginId: string): PluginSettings {
  return {
    get: <T,>(key: string, fallback: T): T => {
      const bag = configs.get(pluginId)
      return bag && key in bag ? (bag[key] as T) : fallback
    },
    all: () => ({ ...(configs.get(pluginId) ?? {}) }),
    set: async (key, value) => {
      const bag = { ...(configs.get(pluginId) ?? {}), [key]: value }
      configs.set(pluginId, bag)
      // Write-through: a settings form that only changed the browser's copy
      // would look correct until the next device signed in.
      const saved = await getRepositories().plugins.setConfig(organization(), pluginId, bag)
      configs.set(pluginId, saved.config)
    },
  }
}

/**
 * The key index for one plugin's data.
 *
 * `plugin_data` is a key/value table with no listing RPC — a plugin reads the
 * keys it knows about. `keys()` still has to answer honestly, so the set of
 * keys this plugin has written is itself kept in the plugin's own namespace,
 * under a reserved name. It is hidden from the answer, so a plugin never sees
 * the bookkeeping.
 */
const DATA_INDEX_KEY = '__keys'

async function dataKeys(pluginId: string): Promise<string[]> {
  try {
    const raw = await getRepositories().plugins.dataGet(organization(), pluginId, DATA_INDEX_KEY)
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

async function writeDataKeys(pluginId: string, keys: string[]): Promise<void> {
  await getRepositories().plugins.dataSet(organization(), pluginId, DATA_INDEX_KEY, keys)
}

function dataFor(pluginId: string): PluginDataStore {
  return {
    get: async <T,>(key: string, fallback: T): Promise<T> => {
      try {
        const value = await getRepositories().plugins.dataGet(organization(), pluginId, key)
        return value === null || value === undefined ? fallback : (value as T)
      } catch {
        // Plugin data must never be the reason a POS screen fails to draw.
        return fallback
      }
    },
    set: async (key, value) => {
      await getRepositories().plugins.dataSet(organization(), pluginId, key, value)
      if (key === DATA_INDEX_KEY) return
      const keys = await dataKeys(pluginId)
      if (!keys.includes(key)) await writeDataKeys(pluginId, [...keys, key])
    },
    remove: async (key) => {
      const removed = await getRepositories().plugins.dataDelete(organization(), pluginId, key)
      const keys = await dataKeys(pluginId)
      if (keys.includes(key)) await writeDataKeys(pluginId, keys.filter((entry) => entry !== key))
      return removed
    },
    keys: async () => (await dataKeys(pluginId)).filter((key) => key !== DATA_INDEX_KEY),
  }
}

const hostServices: PluginHostServices = {
  settings: settingsFor,
  data: dataFor,
  // Read without loading: entitlement has to be decided before the plugin's
  // first line runs, and the licence lives in the same config bag.
  config: (pluginId) => ({ ...(configs.get(pluginId) ?? {}) }),
  db: (pluginId) => ({
    products: () => getRepositories().plugins.products(organization()),
    rpc: (fn, args) => getRepositories().plugins.rpc(organization(), pluginId, fn, args),
  }),
}

export const pluginRegistry = new PluginRegistry(eventBus, hostServices)

/** Everything this bundle ships. Adding a plugin is adding one entry here. */
export const SHIPPED_PLUGINS: readonly ShippedPlugin[] = [
  {
    manifest: barcodeScannerManifest,
    load: async () => (await import('../plugins/barcode-scanner')).barcodeScannerPlugin,
    // Device setup, not a capability the shop buys. See `alwaysOn`.
    alwaysOn: true,
  },
  {
    manifest: batchExpiryManifest,
    load: async () => (await import('../plugins/batch-expiry')).batchExpiryPlugin,
  },
  {
    manifest: bdVatManifest,
    load: async () => (await import('../plugins/bd-vat')).bdVatPlugin,
  },
  {
    manifest: dueLedgerManifest,
    load: async () => (await import('../plugins/due-ledger')).dueLedgerPlugin,
  },
  {
    manifest: labelPrintingManifest,
    load: async () => (await import('../plugins/label-printing')).labelPrintingPlugin,
    // Paper for the shop's own scanner — hardware working, not a capability
    // the shop buys. See `alwaysOn` on ShippedPlugin.
    alwaysOn: true,
  },
  {
    manifest: loyaltyManifest,
    load: async () => (await import('../plugins/loyalty')).loyaltyPlugin,
  },
  {
    manifest: loyaltyLiteManifest,
    load: async () => (await import('../plugins/loyalty-lite')).loyaltyLitePlugin,
  },
  {
    manifest: printerSetupManifest,
    load: async () => (await import('../plugins/printer-setup')).printerSetupPlugin,
    alwaysOn: true,
  },
  {
    manifest: serialNumbersManifest,
    load: async () => (await import('../plugins/serial-numbers')).serialNumbersPlugin,
  },
  {
    manifest: variantsManifest,
    load: async () => (await import('../plugins/variants')).variantsPlugin,
  },
  {
    manifest: warrantyManifest,
    load: async () => (await import('../plugins/warranty')).warrantyPlugin,
  },
  {
    manifest: weightScaleManifest,
    load: async () => (await import('../plugins/weight-scale')).weightScalePlugin,
  },
]

for (const shipped of SHIPPED_PLUGINS) pluginRegistry.declare(shipped)

/** A manifest that fails validation must not take the app down with it. */
export function declareShippedPlugins(): string[] {
  const problems: string[] = []
  for (const registration of pluginRegistry.list()) {
    if (registration.status === 'error' && registration.error) {
      problems.push(`${registration.id}: ${registration.error}`)
    }
  }
  return problems
}

/**
 * Make the loaded set match this shop's toggles.
 *
 * Called on sign-in and again whenever the Plugins screen changes something,
 * which is what lets a shopkeeper enable a plugin and use it without a reload.
 * A failure to read the catalogue leaves the shop with core screens rather
 * than a blank app — plugins are optional by construction.
 */
export function alwaysOnPlugins(): string[] {
  return SHIPPED_PLUGINS.filter((shipped) => shipped.alwaysOn === true).map(
    (shipped) => shipped.manifest.id
  )
}

export async function syncPlugins(): Promise<void> {
  const organizationId = sessionStore.state.activeOrganizationId
  if (!organizationId) {
    pluginRegistry.disposeAll()
    return
  }

  // The always-on set loads before the catalogue is even asked for, and
  // stays loaded if the answer never comes. Printer Setup and Barcode
  // Scanner were core screens until they were split into plugins, and a
  // shopkeeper whose server has not been migrated yet — or who is simply
  // offline — must still be able to pair a printer. Nothing here can charge
  // money or own a table, so there is no decision being made on their behalf.
  const alwaysOn = alwaysOnPlugins()

  try {
    // `state`, not `catalog`: loading the app needs only what this shop has
    // switched on, and a cashier does not hold `plugins.view`. Asking for the
    // admin list here would have made every plugin screen fail to load for
    // everyone but an owner.
    const state = await getRepositories().plugins.state(organizationId)
    for (const entry of state) configs.set(entry.key, entry.config)

    // A plugin the database recorded as failed stays installed but unloaded;
    // the Plugins screen shows the error and offers a retry.
    const enabled = state
      .filter((entry) => entry.enabled && entry.status === 'ok')
      .map((entry) => entry.key)

    await pluginRegistry.sync([...new Set([...alwaysOn, ...enabled])])
  } catch (error) {
    console.error('[mekholi] the shop’s plugin state could not be read', error)
    // Core screens that happen to be packaged as plugins are not optional
    // just because the catalogue is unreachable.
    try {
      await pluginRegistry.sync(alwaysOn)
    } catch (fallbackError) {
      console.error('[mekholi] the always-on plugins could not be loaded', fallbackError)
    }
  }
}

/** Settings a screen or widget should show for a plugin (used by Settings). */
export function pluginConfig(pluginId: string): Record<string, unknown> {
  return { ...(configs.get(pluginId) ?? {}) }
}

/** Remember what the catalogue said, without a round trip. */
export function rememberConfig(pluginId: string, config: Record<string, unknown>): void {
  configs.set(pluginId, config)
}
