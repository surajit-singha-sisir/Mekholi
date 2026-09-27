/**
 * Multi-Currency Display — behaviour.
 *
 * One nav entry, one screen, and one push: the plugin resolves the shop's
 * chosen conversion and hands `shared/domain/money` a provider, the same
 * inversion the i18n layer uses for locale. From that moment every
 * `formatMoney` in the app — dashboards, the till, reports, the receipt —
 * shows the display currency, and no feature file knows the plugin exists.
 *
 * The provider activates in `register`, before any screen is visited: a
 * shop that configured dollars yesterday reads dollars at today's login.
 * When the cached rate is a day old and the device is online, a fresh
 * table is fetched quietly in the background; a failure changes nothing —
 * the shop keeps converting on the rate it had.
 *
 * `dispose` pulls the provider back out. Money then formats exactly as if
 * the plugin had never shipped — the stored amounts were never touched.
 *
 * This file imports nothing from `src/features/` and nothing from another
 * plugin (spec §51).
 */

import type { Plugin, PluginSettings } from '../../shared/registry/plugin-types'
import {
  resetDisplayConversionProvider,
  setDisplayConversionProvider,
  type DisplayConversion,
} from '../../shared/domain/money'
import { MULTI_CURRENCY_ID, MULTI_CURRENCY_MANAGE, multiCurrencyManifest } from './manifest'
import { fetchRateTable, isStale, readConfig, resolveConversion, writeConfig, type MultiCurrencyConfig } from './engine'

let active: DisplayConversion | null = null

function activate(config: MultiCurrencyConfig, base: string): void {
  active = resolveConversion(config, base)
}

/** What the screen needs from the host — kept narrow so the screen tests dry. */
export interface CurrencyScreenHost {
  /** The shop's base currency, straight from the page context. */
  base: string
  config(): MultiCurrencyConfig
  /** Persist and re-push the provider in one motion. */
  save(config: MultiCurrencyConfig): Promise<void>
  /** Fetch a fresh live table. Null when offline or the feed misbehaves. */
  refresh(): Promise<MultiCurrencyConfig['table']>
}

function hostFor(settings: PluginSettings, base: string): CurrencyScreenHost {
  return {
    base,
    config: () => readConfig(settings),
    save: async (config) => {
      await writeConfig(settings, config)
      activate(config, config.base || base)
    },
    refresh: () => fetchRateTable(),
  }
}

export const multiCurrencyPlugin: Plugin = {
  id: MULTI_CURRENCY_ID,
  name: multiCurrencyManifest.name,
  version: multiCurrencyManifest.version,
  description: multiCurrencyManifest.description,
  ...(multiCurrencyManifest.icon ? { icon: multiCurrencyManifest.icon } : {}),

  register(api) {
    setDisplayConversionProvider(() => active)

    const config = readConfig(api.settings)
    activate(config, config.base)

    // Quiet refresh: only when the shop actually converts on the live feed,
    // the cache has gone stale, and the device believes it is online.
    const online = typeof navigator === 'undefined' || navigator.onLine !== false
    if (config.target && config.mode === 'live' && isStale(config.table) && online) {
      void fetchRateTable().then(async (table) => {
        if (!table) return
        const fresh = { ...readConfig(api.settings), table }
        await writeConfig(api.settings, fresh)
        activate(fresh, fresh.base)
      })
    }

    api.registerNav({
      id: 'multi-currency',
      label: 'Currency',
      icon: 'currency_exchange',
      section: 'admin',
      route: '/plugins/multi-currency',
      permission: MULTI_CURRENCY_MANAGE,
      order: 57,
    })

    api.registerRoute({
      path: '/plugins/multi-currency',
      title: 'Multi-Currency Display',
      permission: MULTI_CURRENCY_MANAGE,
      load: async () => {
        const screen = await import('./currency-screen')
        return {
          render: (ctx) => screen.createCurrencyScreen(hostFor(api.settings, ctx.currency)),
        }
      },
    })
  },

  dispose() {
    active = null
    resetDisplayConversionProvider()
  },
}
