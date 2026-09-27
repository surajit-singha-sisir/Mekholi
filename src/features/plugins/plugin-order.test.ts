/**
 * The plugin shelf order.
 *
 * What must hold: running plugins above idle ones, the most recently
 * switched on at the very top, everything idle in name order — and no
 * crash on the rows that never carried a timestamp.
 */

import { describe, expect, it } from 'vitest'
import { pluginShelfOrder } from './plugin-order'
import type { PluginCatalogEntry } from '../../shared/repositories/contracts'

const entry = (over: Partial<PluginCatalogEntry>): PluginCatalogEntry => ({
  key: 'x',
  name: 'X',
  category: 'optional',
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description: null,
  dependencies: [],
  conflicts: [],
  installed: false,
  enabled: false,
  status: 'ok',
  lastError: null,
  config: {},
  enabledAt: null,
  permissions: [],
  migrationsTotal: 0,
  migrationsPending: 0,
  ...over,
})

describe('pluginShelfOrder', () => {
  it('puts what runs above what waits, newest switch-on first', () => {
    const rows = [
      entry({ key: 'idle-a', name: 'Aardvark' }),
      entry({ key: 'old', name: 'Old', enabled: true, enabledAt: '2026-09-01T10:00:00Z' }),
      entry({ key: 'idle-z', name: 'Zebra' }),
      entry({ key: 'new', name: 'New', enabled: true, enabledAt: '2026-09-27T10:00:00Z' }),
    ].sort(pluginShelfOrder)
    expect(rows.map((row) => row.key)).toEqual(['new', 'old', 'idle-a', 'idle-z'])
  })

  it('keeps name order among the idle, whatever the catalogue sent', () => {
    const rows = [entry({ name: 'Warranty' }), entry({ name: 'Branch' }), entry({ name: 'Loyalty' })]
      .sort(pluginShelfOrder)
      .map((row) => row.name)
    expect(rows).toEqual(['Branch', 'Loyalty', 'Warranty'])
  })

  it('survives enabled rows with no timestamp — they sink below dated ones, in name order', () => {
    const rows = [
      entry({ key: 'undated-b', name: 'B', enabled: true, enabledAt: null }),
      entry({ key: 'dated', name: 'Dated', enabled: true, enabledAt: '2026-09-27T10:00:00Z' }),
      entry({ key: 'undated-a', name: 'A', enabled: true, enabledAt: 'garbage' }),
    ].sort(pluginShelfOrder)
    expect(rows.map((row) => row.key)).toEqual(['dated', 'undated-a', 'undated-b'])
  })
})
