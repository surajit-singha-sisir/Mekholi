/**
 * The rate engine.
 *
 * What must hold: a USD-anchored table crosses to any base/target pair, a
 * manual rate beats the feed when the shopkeeper chose it, an unusable
 * rate (zero, missing, feed down) means *no* conversion rather than a
 * wrong one, and a day-old cache admits it is stale.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PluginSettings } from '../../shared/registry/plugin-types'
import {
  crossRate,
  fetchRateTable,
  isStale,
  readConfig,
  resolveConversion,
  writeConfig,
  STALE_AFTER_MS,
  type MultiCurrencyConfig,
  type RateTable,
} from './engine'

const table = (rates: Record<string, number>, fetchedAt = new Date().toISOString()): RateTable => ({
  rates,
  fetchedAt,
})

const config = (over: Partial<MultiCurrencyConfig>): MultiCurrencyConfig => ({
  target: 'USD',
  mode: 'live',
  manualRate: 0,
  base: 'BDT',
  table: null,
  ...over,
})

function memorySettings(initial: Record<string, unknown> = {}): PluginSettings {
  const bag = new Map(Object.entries(initial))
  return {
    get: <T,>(key: string, fallback: T): T => (bag.has(key) ? (bag.get(key) as T) : fallback),
    all: () => Object.fromEntries(bag) as Readonly<Record<string, unknown>>,
    set: async (key, value) => {
      bag.set(key, value)
    },
  }
}

describe('crossRate', () => {
  it('crosses any pair through the dollar anchor', () => {
    const t = table({ USD: 1, BDT: 122.5, EUR: 0.92 })
    expect(crossRate(t, 'BDT', 'USD')).toBeCloseTo(122.5)
    expect(crossRate(t, 'BDT', 'EUR')).toBeCloseTo(122.5 / 0.92)
    expect(crossRate(t, 'EUR', 'BDT')).toBeCloseTo(0.92 / 122.5)
  })

  it('answers null, never zero or Infinity, when a leg is missing', () => {
    const t = table({ USD: 1, BDT: 122.5 })
    expect(crossRate(t, 'BDT', 'XXX')).toBeNull()
    expect(crossRate(t, 'XXX', 'USD')).toBeNull()
  })
})

describe('isStale', () => {
  it('trusts a fresh table and doubts an old or broken one', () => {
    const now = Date.now()
    expect(isStale(table({ USD: 1 }, new Date(now - 1000).toISOString()), now)).toBe(false)
    expect(isStale(table({ USD: 1 }, new Date(now - STALE_AFTER_MS - 1).toISOString()), now)).toBe(true)
    expect(isStale(table({ USD: 1 }, 'not a date'), now)).toBe(true)
    expect(isStale(null, now)).toBe(true)
  })
})

describe('resolveConversion', () => {
  it('resolves the shop’s example: BDT base, USD target, live table', () => {
    const conv = resolveConversion(config({ table: table({ USD: 1, BDT: 122.5 }) }), 'BDT')
    expect(conv).toEqual({ code: 'USD', decimals: 2, rate: 122.5 })
  })

  it('lets the hand-set rate beat the feed in manual mode', () => {
    const conv = resolveConversion(
      config({ mode: 'manual', manualRate: 120, table: table({ USD: 1, BDT: 122.5 }) }),
      'BDT'
    )
    expect(conv?.rate).toBe(120)
  })

  it('answers null rather than convert on nothing', () => {
    expect(resolveConversion(config({ target: '' }), 'BDT')).toBeNull()
    expect(resolveConversion(config({ target: 'BDT' }), 'BDT')).toBeNull()
    expect(resolveConversion(config({ mode: 'manual', manualRate: 0 }), 'BDT')).toBeNull()
    expect(resolveConversion(config({ mode: 'live', table: null }), 'BDT')).toBeNull()
  })

  it('carries the target currency’s own decimals — dinar gets three', () => {
    const conv = resolveConversion(config({ target: 'KWD', mode: 'manual', manualRate: 400 }), 'BDT')
    expect(conv).toEqual({ code: 'KWD', decimals: 3, rate: 400 })
  })

  it('falls back to the stored base when the caller has none to offer', () => {
    const conv = resolveConversion(config({ mode: 'manual', manualRate: 122.5 }), '')
    expect(conv?.code).toBe('USD')
  })
})

describe('config round trip', () => {
  it('reads back what it wrote, and normalises rubbish to safe defaults', async () => {
    const settings = memorySettings()
    const saved = config({ mode: 'manual', manualRate: 122.5, table: table({ USD: 1, BDT: 122.5 }) })
    await writeConfig(settings, saved)
    expect(readConfig(settings)).toEqual(saved)

    const dirty = memorySettings({ target: ' usd ', mode: 'nonsense', manualRate: -4, rateTable: 42 })
    expect(readConfig(dirty)).toEqual(config({ target: 'USD', mode: 'live', manualRate: 0, base: '' }))
  })
})

describe('fetchRateTable', () => {
  it('trims the feed to currencies the picker offers and stamps the time', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'success', rates: { USD: 1, BDT: 122.5, XAU: 0.0005, FAKE: 9 } }),
    }) as unknown as typeof fetch
    const got = await fetchRateTable(fetchImpl)
    expect(got?.rates).toEqual({ USD: 1, BDT: 122.5 })
    expect(Date.parse(got!.fetchedAt)).not.toBeNaN()
  })

  it('returns null — not a throw, not a half-table — on any failure', async () => {
    const down = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    expect(await fetchRateTable(down)).toBeNull()

    const denied = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch
    expect(await fetchRateTable(denied)).toBeNull()

    const weird = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: 'error' }) }) as unknown as typeof fetch
    expect(await fetchRateTable(weird)).toBeNull()
  })
})
