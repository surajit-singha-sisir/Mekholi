/**
 * The notification engine.
 *
 * What must hold: the feed becomes items ranked by what stops sales
 * first, a switched-off watcher stays silent whatever the feed says, a
 * changed fact re-arms a dismissed item (the signature moves), and the
 * money in the sentences is real money formatting.
 */

import { describe, expect, it } from 'vitest'
import {
  buildItems,
  readPrefs,
  seenSignatures,
  unseenCount,
  writePrefs,
  DEFAULT_PREFS,
  type NotificationsFeed,
} from './engine'
import type { PluginSettings } from '../../shared/registry/plugin-types'

const FEED: NotificationsFeed = {
  stock: { out_count: 2, out_names: ['Atta 2kg', 'Soap'], low_count: 1, low_names: ['Salt'] },
  dues: { debtor_count: 3, total_due_minor: 250000, top_name: 'Karim', top_due_minor: 140000 },
  summary: { sale_count: 12, total_minor: 3450000 },
}

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

describe('buildItems', () => {
  it('ranks by urgency: out of stock, then low and dues, then the day', () => {
    const items = buildItems(FEED, DEFAULT_PREFS, 'BDT')
    expect(items.map((item) => item.id)).toEqual(['out-of-stock', 'low-stock', 'dues', 'summary'])
    expect(items[0]!.severity).toBe('danger')
    expect(items[0]!.title).toBe('2 products are out of stock')
    expect(items[0]!.body).toBe('Atta 2kg, Soap.')
  })

  it('says the money like money: ৳2,500.00 due, Karim owes the most', () => {
    const dues = buildItems(FEED, DEFAULT_PREFS, 'BDT').find((item) => item.id === 'dues')!
    expect(dues.title).toContain('2,500.00')
    expect(dues.title).toContain('3 customers')
    expect(dues.body).toContain('Karim')
    expect(dues.body).toContain('1,400.00')
  })

  it('admits when the name list was capped', () => {
    const feed: NotificationsFeed = {
      stock: { out_count: 7, out_names: ['A', 'B', 'C', 'D', 'E'], low_count: 0, low_names: [] },
    }
    expect(buildItems(feed, DEFAULT_PREFS, 'BDT')[0]!.body).toBe('A, B, C, D, E and 2 more.')
  })

  it('keeps a switched-off watcher silent whatever the feed says', () => {
    const items = buildItems(FEED, { ...DEFAULT_PREFS, stock: false, dues: false }, 'BDT')
    expect(items.map((item) => item.id)).toEqual(['summary'])
  })

  it('produces nothing from a quiet shop — no list of zeros', () => {
    const quiet: NotificationsFeed = {
      stock: { out_count: 0, out_names: [], low_count: 0, low_names: [] },
      dues: { debtor_count: 0, total_due_minor: 0, top_name: null, top_due_minor: 0 },
      summary: { sale_count: 0, total_minor: 0 },
    }
    expect(buildItems(quiet, DEFAULT_PREFS, 'BDT')).toEqual([])
  })
})

describe('the read arithmetic', () => {
  it('a dismissed item stays dismissed until the fact behind it changes', () => {
    const before = buildItems(FEED, DEFAULT_PREFS, 'BDT')
    const seen = seenSignatures(before)
    expect(unseenCount(before, seen)).toBe(0)

    // One more product runs out: the signature moves, the item re-arms.
    const worse: NotificationsFeed = {
      ...FEED,
      stock: { ...FEED.stock!, out_count: 3, out_names: ['Atta 2kg', 'Rice', 'Soap'] },
    }
    const after = buildItems(worse, DEFAULT_PREFS, 'BDT')
    expect(unseenCount(after, seen)).toBe(1)
  })
})

describe('prefs round trip', () => {
  it('reads back what it wrote, and treats rubbish as the defaults', async () => {
    const settings = memorySettings()
    await writePrefs(settings, { stock: false, dues: true, summary: false, dueFloorMinor: 5000 })
    expect(readPrefs(settings)).toEqual({ stock: false, dues: true, summary: false, dueFloorMinor: 5000 })

    const dirty = memorySettings({ dueFloorMinor: -50 })
    expect(readPrefs(dirty)).toEqual(DEFAULT_PREFS)
  })
})
