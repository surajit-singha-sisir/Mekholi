/**
 * Multi-Currency Display — the engine.
 *
 * Everything that is arithmetic or plumbing lives here, away from the DOM,
 * so a test can hold it down: reading the org-scoped settings into a shape,
 * turning a USD-anchored rate table into a base→target rate, deciding when
 * a cached table is too old to trust, and fetching a fresh one.
 *
 * ── Why the table anchors on USD ─────────────────────────────────────────
 * The feed is asked for USD rates once, whatever the shop's base currency.
 * `rates[X]` = how many X one dollar buys, so *any* pair crosses through it:
 * BDT per EUR = rates.BDT / rates.EUR. One fetch therefore serves every
 * base and every target — including a shop that changes either later,
 * offline, on the cached table.
 *
 * ── The rate's direction ─────────────────────────────────────────────────
 * A rate here is always "base major units per ONE target major unit":
 * `1 USD = 122.50 BDT` is 122.5. That is the direction a Bangladeshi
 * shopkeeper quotes dollars in, and the direction `DisplayConversion.rate`
 * (shared/domain/money) expects.
 */

import type { DisplayConversion } from '../../shared/domain/money'
import { CURRENCIES, findCurrency } from '../../shared/domain/currencies'
import type { PluginSettings } from '../../shared/registry/plugin-types'

/** USD-anchored table: `rates[X]` = units of X per one US dollar. */
export interface RateTable {
  rates: Record<string, number>
  /** ISO timestamp of when this device fetched it. */
  fetchedAt: string
}

export interface MultiCurrencyConfig {
  /** ISO code the screen should show. Empty string = conversion off. */
  target: string
  /** Where the rate comes from. */
  mode: 'live' | 'manual'
  /** Base major per one target major, when the shopkeeper set it by hand. */
  manualRate: number
  /**
   * The base currency the shop had when the screen last saved. Stored so
   * the provider can activate at startup, before any screen has run and
   * handed us a page context.
   */
  base: string
  /** The last live table this org fetched, if any. */
  table: RateTable | null
}

/** The open, keyless endpoint of exchangerate-api.com. */
export const RATE_ENDPOINT = 'https://open.er-api.com/v6/latest/USD'

/** A cached rate older than a day is refreshed when the network allows. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

const KEYS = {
  target: 'target',
  mode: 'mode',
  manualRate: 'manualRate',
  base: 'base',
  table: 'rateTable',
} as const

export function readConfig(settings: PluginSettings): MultiCurrencyConfig {
  const mode = settings.get<string>(KEYS.mode, 'live')
  const table = settings.get<RateTable | null>(KEYS.table, null)
  return {
    target: settings.get<string>(KEYS.target, '').trim().toUpperCase(),
    mode: mode === 'manual' ? 'manual' : 'live',
    manualRate: toPositive(settings.get<number>(KEYS.manualRate, 0)),
    base: settings.get<string>(KEYS.base, '').trim().toUpperCase(),
    table: isRateTable(table) ? table : null,
  }
}

export async function writeConfig(settings: PluginSettings, config: MultiCurrencyConfig): Promise<void> {
  await settings.set(KEYS.target, config.target)
  await settings.set(KEYS.mode, config.mode)
  await settings.set(KEYS.manualRate, config.manualRate)
  await settings.set(KEYS.base, config.base)
  await settings.set(KEYS.table, config.table)
}

/** Base major units per one target major unit, crossed through USD. */
export function crossRate(table: RateTable, base: string, target: string): number | null {
  const per = table.rates[base.toUpperCase()]
  const to = table.rates[target.toUpperCase()]
  if (!isPositive(per) || !isPositive(to)) return null
  return per / to
}

export function isStale(table: RateTable | null, now = Date.now()): boolean {
  if (!table) return true
  const at = Date.parse(table.fetchedAt)
  if (!Number.isFinite(at)) return true
  return now - at > STALE_AFTER_MS
}

/**
 * The conversion this config asks for, or null when it asks for none —
 * target unset, target equal to base, or no usable rate yet (manual mode
 * with no rate typed; live mode with nothing cached).
 */
export function resolveConversion(config: MultiCurrencyConfig, base: string): DisplayConversion | null {
  const baseCode = (base || config.base).trim().toUpperCase()
  const target = findCurrency(config.target)
  if (!target || !baseCode || target.code === baseCode) return null

  const rate =
    config.mode === 'manual'
      ? config.manualRate
      : config.table
        ? crossRate(config.table, baseCode, target.code)
        : null
  if (rate === null || !isPositive(rate)) return null

  return { code: target.code, decimals: target.decimals, rate }
}

/**
 * Fetch a fresh table, trimmed to the currencies the picker offers — the
 * feed answers with ~160 codes and the config bag should not carry metals
 * and testing codes forever. Returns null on any failure: a shop offline,
 * a feed down, a shape that is not what it was yesterday. The caller keeps
 * whatever table it already had.
 */
export async function fetchRateTable(fetchImpl: typeof fetch = fetch): Promise<RateTable | null> {
  try {
    const response = await fetchImpl(RATE_ENDPOINT)
    if (!response.ok) return null
    const body = (await response.json()) as { result?: string; rates?: Record<string, unknown> }
    if (body.result !== 'success' || !body.rates || typeof body.rates !== 'object') return null
    const rates: Record<string, number> = {}
    for (const entry of CURRENCIES) {
      const value = body.rates[entry.code]
      if (isPositive(value)) rates[entry.code] = value as number
    }
    if (!isPositive(rates['USD'])) rates['USD'] = 1
    if (Object.keys(rates).length < 2) return null
    return { rates, fetchedAt: new Date().toISOString() }
  } catch {
    return null
  }
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function toPositive(value: unknown): number {
  return isPositive(value) ? value : 0
}

function isRateTable(value: unknown): value is RateTable {
  if (!value || typeof value !== 'object') return false
  const table = value as RateTable
  return typeof table.fetchedAt === 'string' && !!table.rates && typeof table.rates === 'object'
}
