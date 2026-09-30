/**
 * Serial Numbers — tested through the public plugin API.
 *
 * What matters is not that a screen renders but that the plugin asks the shop's
 * server for the right things: the till's scans reach the sale they belong to,
 * a refusal is kept rather than swallowed, another till's sale is left alone,
 * and nothing here writes stock. The SQL itself is exercised against a real
 * Postgres by `npm run validate:migrations`; these tests are about the half
 * that runs in the browser.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../shared/bus/event-bus'
import { PluginRegistry } from '../../shared/registry/plugin-registry'
import { validateManifest } from '../../shared/registry/plugin-manifest'
import type {
  PanelLine,
  PluginDataStore,
  PluginDb,
  PluginSettings,
} from '../../shared/registry/plugin-types'
import serialNumbersPlugin, { TILL_PENDING_KEY, captureCard } from './index'
import { create as createSerialsScreen } from './serials-screen'
import {
  DEFAULT_INTERNAL_PREFIX,
  DEFAULT_REQUIRE_CAPTURE,
  SERIAL_TRACKED_KEY,
  SERIALS_MANAGE,
  SERIALS_VIEW,
  serialNumbersManifest,
} from './manifest'
import {
  describeError,
  lineForScan,
  missingLabel,
  parseSerials,
  printableSheet,
  reasonLabel,
  statusLabel,
  statusTone,
  tillSummary,
  trackedLines,
  type CaptureResult,
  type Overview,
  type PendingScan,
  type SaleInfo,
  type SerialRow,
} from './helpers'

const ORG = '11111111-1111-1111-1111-111111111111'
const BRANCH = '22222222-2222-2222-2222-222222222222'
const SALE = '33333333-3333-3333-3333-333333333333'

// ── A stand-in server ─────────────────────────────────────────────────────

interface Call {
  fn: string
  args: Record<string, unknown>
}

let calls: Call[] = []
let answers: Record<string, unknown> = {}
let refuse: string | null = null
let bus: EventBus
let registry: PluginRegistry
let config: Record<string, unknown> = {}

function makeDb(): PluginDb {
  return {
    products: async () => [],
    rpc: async <T,>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ fn, args })
      if (refuse) throw new Error(refuse)
      const answer = answers[fn]
      // A canned value, or a function when the answer depends on the page
      // being asked for (which is how the paging loop is exercised).
      if (typeof answer === 'function') {
        return (answer as (args: Record<string, unknown>) => unknown)(args) as T
      }
      return (answer ?? null) as T
    },
  }
}

beforeEach(() => {
  calls = []
  answers = {}
  refuse = null
  config = {}
  localStorage.clear()
  bus = new EventBus()
  bus.onError = () => undefined

  const settingsStore: PluginSettings = {
    get: <T,>(key: string, fallback: T): T => (key in config ? (config[key] as T) : fallback),
    all: () => ({ ...config }),
    set: async (key, value) => {
      config[key] = value
    },
  }
  const dataStore: PluginDataStore = {
    get: async <T,>(_key: string, fallback: T): Promise<T> => fallback,
    set: async () => undefined,
    remove: async () => false,
    keys: async () => [],
  }

  registry = new PluginRegistry(bus, {
    settings: () => settingsStore,
    data: () => dataStore,
    db: () => makeDb(),
  })
  registry.declare({ manifest: serialNumbersManifest, load: async () => serialNumbersPlugin })
})

/** Waits for the promises a render or a handler kicked off. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const textOf = (node: Element): string => node.textContent ?? ''

function cartLine(overrides: Partial<PanelLine> = {}): PanelLine[] {
  return [
    {
      variantId: 'v1',
      productId: 'p1',
      name: 'Phone',
      variantName: '128GB',
      sku: 'PH-128',
      quantity: 2,
      unitPrice: 25000,
      metadata: { [SERIAL_TRACKED_KEY]: true },
      ...overrides,
    },
  ]
}

// ── The reports ───────────────────────────────────────────────────────────
// Both are read through the registry and run through the same `run(context)`
// the core reports screen calls. The mapping is what is pinned here: a report
// that shows `IN_STOCK` instead of “In stock”, or that quietly loses the
// second page of an export, is a report a shopkeeper cannot use.

function serialRow(index: number, over: Partial<SerialRow> = {}): SerialRow {
  return {
    id: `s${index}`,
    serial: `IMEI-${String(index).padStart(5, '0')}`,
    status: 'IN_STOCK',
    source: 'MANUAL',
    note: null,
    product_id: 'p1',
    product_name: 'Phone X',
    variant_id: 'v1',
    variant_name: '128GB',
    sku: 'PH-128',
    warehouse: 'Shop Floor',
    sale_id: null,
    invoice_no: null,
    customer: null,
    received_at: '2026-09-01T09:00:00.000Z',
    sold_at: null,
    returned_at: null,
    released_at: null,
    ...over,
  }
}

describe('the reports', () => {
  const report = (id: string) => registry.reports.items.find((entry) => entry.id === id)

  it('registers two, under Stock, both gated on seeing serials', async () => {
    await registry.sync(['serial-numbers'])

    expect(registry.reports.items.map((entry) => entry.id)).toEqual(['units', 'aging'])
    for (const entry of registry.reports.items) {
      expect(entry.group).toBe('Stock')
      expect(entry.permission).toBe(SERIALS_VIEW)
    }
    expect(report('units')?.filters).toEqual({ window: false, search: true })
    expect(report('aging')?.filters).toEqual({ window: false })
  })

  it('pages the pool until the export is satisfied, then stops', async () => {
    await registry.sync(['serial-numbers'])
    const all = Array.from({ length: 450 }, (_, index) => serialRow(index))
    answers['list'] = (args: Record<string, unknown>) => {
      const limit = Number(args.limit ?? 50)
      const offset = Number(args.offset ?? 0)
      return { rows: all.slice(offset, offset + limit), total: all.length, limit, offset }
    }

    const result = await report('units')!.run({
      period: 'month',
      from: null,
      to: null,
      search: '',
      branchId: 'b1',
      limit: 250,
      offset: 0,
    })

    // 250 requested, pages of 200: two calls, and the row count the host uses
    // for “1–250 of 450” is the server's, not the page's.
    const listCalls = calls.filter((call) => call.fn === 'list')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[0]?.args).toMatchObject({ status: 'ALL', limit: 200, offset: 0 })
    expect(listCalls[1]?.args).toMatchObject({ limit: 50, offset: 200 })
    expect(result.rows).toHaveLength(250)
    expect(result.totalRows).toBe(450)
    expect(result.note).toBe('250 of 450 in stock')
  })

  it('reads as a report, not as a schema', async () => {
    await registry.sync(['serial-numbers'])
    answers['list'] = {
      rows: [
        serialRow(1),
        serialRow(2, {
          status: 'SOLD',
          invoice_no: 'INV-2026-000031',
          customer: 'Rahima',
          sold_at: '2026-09-20T11:30:00.000Z',
        }),
      ],
      total: 2,
      limit: 50,
      offset: 0,
    }

    const result = await report('units')!.run({
      period: 'month',
      from: null,
      to: null,
      search: 'rahima',
      branchId: null,
      limit: 50,
      offset: 0,
    })

    expect(result.rows[0]).toMatchObject({ status: 'In stock', invoice: '—', customer: '—' })
    expect(result.rows[1]).toMatchObject({
      status: 'Sold',
      invoice: 'INV-2026-000031',
      customer: 'Rahima',
    })
    // The shopkeeper's search reaches the server, not just the visible page.
    expect(calls.filter((call) => call.fn === 'list')[0]?.args.search).toBe('rahima')
  })

  it('reports how long the shelf stock has been waiting, and what is missing', async () => {
    await registry.sync(['serial-numbers'])
    answers['report'] = {
      window: { days: 30, from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: { sold: 12, returned: 1, in_stock: 40, internal: 6, total: 53 },
      aging: [
        { bucket: '0-30 days', count: 22 },
        { bucket: '31-90 days', count: 12 },
        { bucket: 'over 180 days', count: 6 },
      ],
      by_product: [],
      pending_sales: 2,
      pending_units: 3,
    }

    const result = await report('aging')!.run({
      period: 'month',
      from: null,
      to: null,
      search: '',
      branchId: null,
      limit: 25,
      offset: 0,
    })

    expect(result.rows).toEqual([
      { bucket: '0-30 days', units: 22 },
      { bucket: '31-90 days', units: 12 },
      { bucket: 'over 180 days', units: 6 },
    ])
    expect(result.totals).toEqual({ units: 40 })
    expect(result.note).toContain('6 of 53 numbered by the shop')
    expect(result.note).toContain('3 unit(s) on 2 sale(s) still need a number')
  })

  it('says nothing about missing numbers when there are none', async () => {
    await registry.sync(['serial-numbers'])
    answers['report'] = {
      window: { days: 30, from: '', to: '' },
      totals: { sold: 1, returned: 0, in_stock: 2, internal: 0, total: 3 },
      aging: [{ bucket: '0-30 days', count: 2 }],
      by_product: [],
      pending_sales: 0,
      pending_units: 0,
    }

    const result = await report('aging')!.run({
      period: 'month',
      from: null,
      to: null,
      search: '',
      branchId: null,
      limit: 25,
      offset: 0,
    })

    expect(result.note).toBe('0 of 3 numbered by the shop')
  })
})

// ── Manifest ──────────────────────────────────────────────────────────────

describe('manifest', () => {
  it('is valid, and would be refused if it minted a core permission', () => {
    expect(() => validateManifest(serialNumbersManifest)).not.toThrow()
    expect(() =>
      validateManifest({
        ...serialNumbersManifest,
        permissions: [{ key: 'inventory.edit', label: 'x', group: 'inventory' }],
      })
    ).toThrow()
  })

  it('namespaces every permission to the plugin', () => {
    for (const permission of serialNumbersManifest.permissions ?? []) {
      expect(permission.key.startsWith('serial-numbers.')).toBe(true)
    }
    expect(serialNumbersManifest.version).toBe('1.0.0')
  })

  it('declares the settings keys the server actually reads', () => {
    // `app.serial_numbers_config` reads these three names out of
    // `plugins.config`; a manifest that declared anything else would show a
    // shop a switch that nothing obeys.
    expect(serialNumbersManifest.settingsSchema?.map((field) => field.key)).toEqual([
      'require_capture',
      'internal_prefix',
      'allow_over_stock',
    ])
    expect(serialNumbersManifest.settingsSchema?.[1]?.default).toBe(DEFAULT_INTERNAL_PREFIX)
    expect(serialNumbersManifest.settingsSchema?.[0]?.default).toBe(DEFAULT_REQUIRE_CAPTURE)
  })
})

// ── Registration ──────────────────────────────────────────────────────────

describe('registration', () => {
  it('appears where a shopkeeper would look for it', async () => {
    await registry.sync(['serial-numbers'])

    expect(registry.nav.items.map((item) => item.id)).toEqual(['serial-numbers'])
    expect(registry.nav.items[0]?.section).toBe('inventory')
    expect(registry.routes.items.map((route) => route.path)).toEqual(['/plugins/serial-numbers'])
    expect(registry.widgets.items.map((widget) => widget.id)).toEqual(['serial-numbers.summary'])
    expect(registry.posPanels.items.map((panel) => panel.id)).toEqual(['serial-numbers.till'])
    expect(registry.saleTabs.items.map((tab) => tab.id)).toEqual(['serial-numbers.sale'])
    expect(registry.formSections.items.map((section) => section.id)).toEqual(['serial-numbers.product'])

    const keys = registry.permissions.items.map((permission) => permission.key).sort()
    expect(keys).toEqual([SERIALS_MANAGE, SERIALS_VIEW])
  })

  it('registers the product field the taxonomy promotes, and stores it in metadata', async () => {
    await registry.sync(['serial-numbers'])
    const field = registry.productFields.items[0]

    expect(field?.key).toBe(SERIAL_TRACKED_KEY)
    expect(field?.type).toBe('boolean')
    expect(field?.storage).toBe('metadata')
    expect(field?.importable).toBe(true)
    // A unit number is per unit, so it is not a printable field: what prints is
    // decided by the sale, not by the product (see the sale tab).
    expect(field?.printable).toBeUndefined()
  })

  it('refuses serial tracking for a product that does not track stock', async () => {
    await registry.sync(['serial-numbers'])
    const field = registry.productFields.items[0]
    const draft = { name: 'Soap', price: 1, cost_price: 1, track_stock: false, metadata: {} }

    expect(field?.validate?.(true, draft)).toMatch(/stock tracking/)
    expect(field?.validate?.(false, draft)).toBeNull()
  })

  it('asks for no dependency, so it can be switched on alone', () => {
    expect(serialNumbersManifest.dependencies ?? []).toEqual([])
  })
})

// ── A pasted delivery ─────────────────────────────────────────────────────

describe('a pasted list', () => {
  it('splits on everything a spreadsheet, a scanner and a notes app produce', () => {
    const parsed = parseSerials('A1, A2\nA3;A4\tA5\n\n')
    expect(parsed.serials).toEqual(['A1', 'A2', 'A3', 'A4', 'A5'])
    expect(parsed.blanks).toBe(1)
  })

  it('counts a unit listed twice once, and says so', () => {
    const parsed = parseSerials('imei-1\nIMEI-1\n')
    expect(parsed.serials).toEqual(['imei-1'])
    expect(parsed.duplicates).toEqual(['IMEI-1'])
  })

  it('stops at the batch limit instead of asking the server to refuse it', () => {
    const parsed = parseSerials(Array.from({ length: 12 }, (_, i) => `S${i}`).join('\n'), 10)
    expect(parsed.serials).toHaveLength(10)
    expect(parsed.overflow).toBe(2)
  })
})

// ── Sentences ─────────────────────────────────────────────────────────────

describe('what a shopkeeper reads', () => {
  it('turns a server name into a sentence', () => {
    expect(reasonLabel('over_stock')).toMatch(/in stock/)
    expect(reasonLabel('already_registered')).toBe('already registered')
    expect(reasonLabel('something_new')).toBe('something new')
  })

  it('turns a database refusal into a sentence, and never invents one', () => {
    expect(describeError(new Error('permission_denied: serial-numbers.manage'))).toBe(
      'your role does not allow this'
    )
    expect(describeError(new Error('serial_unknown_sale: 5f0a'))).toBe('that sale is not this shop’s')
    expect(describeError(new Error('a brand new problem'))).toBe('a brand new problem')
  })

  it('names a status and picks its colour', () => {
    expect(statusLabel('IN_STOCK')).toBe('In stock')
    expect(statusTone('SOLD')).toBe('info')
    expect(missingLabel(0)).toBe('every unit has a number')
    expect(missingLabel(2)).toBe('2 units still need a number')
  })
})

// ── The till ──────────────────────────────────────────────────────────────

describe('the till panel', () => {
  const panel = () => registry.posPanels.items[0]

  async function open(lines = cartLine()): Promise<HTMLElement> {
    await registry.sync(['serial-numbers'])
    return (await panel()!.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      total: 50000,
      customerId: null,
      lines,
    }))!
  }

  function scanInto(host: HTMLElement, serial: string): void {
    const box = host.querySelector<HTMLInputElement>('input')
    if (!box) throw new Error('the panel has no scan box')
    box.value = serial
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }

  it('only asks about the products that asked to be tracked', async () => {
    const host = await open([
      ...cartLine(),
      {
        variantId: 'v2',
        productId: 'p2',
        name: 'Charger',
        variantName: null,
        sku: null,
        quantity: 1,
        unitPrice: 500,
        metadata: {},
      },
    ])

    expect(textOf(host)).toContain('Phone — 128GB')
    expect(textOf(host)).not.toContain('Charger')
  })

  it('keeps a scan on the device, and counts it against the line', async () => {
    const host = await open()
    expect(textOf(host)).toContain('0/2')

    scanInto(host, '356938035643809')

    expect(textOf(host)).toContain('1/2')
    const stored = JSON.parse(localStorage.getItem(`mekholi.plugin.serial-numbers.${TILL_PENDING_KEY}`) ?? '[]')
    expect(stored).toEqual([
      expect.objectContaining({ serial: '356938035643809', variantId: 'v1' }),
    ])
  })

  it('will not take the same unit twice for one sale', async () => {
    const host = await open()
    scanInto(host, '356938035643809')
    scanInto(host, '356938035643809')

    const stored = JSON.parse(localStorage.getItem(`mekholi.plugin.serial-numbers.${TILL_PENDING_KEY}`) ?? '[]')
    expect(stored).toHaveLength(1)
  })

  it('says when there is nothing to scan, rather than showing an empty box', async () => {
    const host = await open([
      {
        variantId: 'v2',
        productId: 'p2',
        name: 'Charger',
        variantName: null,
        sku: null,
        quantity: 1,
        unitPrice: 500,
        metadata: {},
      },
    ])

    expect(textOf(host)).toContain('No serial-tracked product in this cart')
    expect(host.querySelector('input')).toBeNull()
  })
})

// ── Attaching the till's scans to a sale ──────────────────────────────────

describe('a completed sale', () => {
  const completed = (overrides: Record<string, unknown> = {}) => ({
    id: 'outbox-1',
    organization_id: ORG,
    aggregate: 'sale' as const,
    type: 'sale.completed' as const,
    created_at: '2026-09-26T10:00:00.000Z',
    version: 1,
    data: {
      sale_id: SALE,
      invoice_no: 'INV-2026-000042',
      branch_id: BRANCH,
      customer_id: null,
      total: '500.00',
      ...overrides,
    },
  })

  async function withScan(serial = '356938035643809'): Promise<void> {
    await registry.sync(['serial-numbers'])
    const host = (await registry.posPanels.items[0]!.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      total: 50000,
      customerId: null,
      lines: cartLine(),
    }))!
    const box = host.querySelector<HTMLInputElement>('input')!
    box.value = serial
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
  }

  it('attaches what was scanned, and clears the till', async () => {
    answers.capture = { sale_id: SALE, captured: 1, refusals: [], lines: [], missing: 1 } satisfies CaptureResult
    await withScan()

    bus.emit('sale.completed', completed())
    await settle()

    const capture = calls.find((call) => call.fn === 'capture')
    expect(capture?.args).toEqual({ sale_id: SALE, serials: ['356938035643809'] })
    const stored = JSON.parse(localStorage.getItem(`mekholi.plugin.serial-numbers.${TILL_PENDING_KEY}`) ?? '[]')
    expect(stored).toEqual([])
  })

  it('keeps a unit the server refused, so the shop can fix it later', async () => {
    answers.capture = {
      sale_id: SALE,
      captured: 1,
      refusals: [{ serial: '356938035643810', reason: 'variant_not_on_sale' }],
      lines: [],
      missing: 0,
    } satisfies CaptureResult
    await withScan('356938035643810')

    bus.emit('sale.completed', completed())
    await settle()

    const stored = JSON.parse(localStorage.getItem(`mekholi.plugin.serial-numbers.${TILL_PENDING_KEY}`) ?? '[]')
    expect(stored.map((entry: PendingScan) => entry.serial)).toEqual(['356938035643810'])
  })

  it('sends one sale once, however many times the event arrives', async () => {
    answers.capture = { sale_id: SALE, captured: 1, refusals: [], lines: [], missing: 0 } satisfies CaptureResult
    await withScan()

    // The till's own echo and the outbox row over Realtime: two deliveries,
    // one sale (shared/bus/events.ts).
    bus.emit('sale.completed', completed())
    bus.emit('sale.completed', { ...completed(), id: 'outbox-row-9' })
    await settle()

    expect(calls.filter((call) => call.fn === 'capture')).toHaveLength(1)
  })

  it('leaves another till’s sale alone, and keeps the scans', async () => {
    await withScan()

    bus.emit('sale.completed', completed({ branch_id: '99999999-9999-9999-9999-999999999999' }))
    await settle()

    expect(calls.filter((call) => call.fn === 'capture')).toHaveLength(0)
    const stored = JSON.parse(localStorage.getItem(`mekholi.plugin.serial-numbers.${TILL_PENDING_KEY}`) ?? '[]')
    expect(stored).toHaveLength(1)
  })

  it('keeps the scans when the shop’s server cannot be reached', async () => {
    await withScan()
    refuse = 'offline'

    bus.emit('sale.completed', completed())
    await settle()

    const stored = JSON.parse(localStorage.getItem(`mekholi.plugin.serial-numbers.${TILL_PENDING_KEY}`) ?? '[]')
    expect(stored).toHaveLength(1)

    // …and the next sale can still have them attached.
    refuse = null
    answers.capture = { sale_id: SALE, captured: 1, refusals: [], lines: [], missing: 0 } satisfies CaptureResult
    bus.emit('sale.completed', { ...completed(), data: { ...completed().data, sale_id: 'other-sale' } })
    await settle()

    expect(calls.filter((call) => call.fn === 'capture')).toHaveLength(2)
  })

  it('marks returned units when a refund is raised', async () => {
    answers.sync_refunds = { marked: 1, lines: 1 }
    await registry.sync(['serial-numbers'])

    bus.emit('sale.refunded', {
      id: 'outbox-2',
      organization_id: ORG,
      aggregate: 'sale' as const,
      type: 'sale.refunded' as const,
      created_at: '2026-09-26T10:05:00.000Z',
      version: 1,
      data: { sale_id: SALE, invoice_no: 'INV-2026-000042', refund_id: 'r1' },
    })
    await settle()

    expect(calls.find((call) => call.fn === 'sync_refunds')?.args).toEqual({ sale_id: SALE })
  })
})

// ── The capture card ──────────────────────────────────────────────────────

describe('the capture card', () => {
  const settings: PluginSettings = {
    get: <T,>(key: string, fallback: T): T => (key in config ? (config[key] as T) : fallback),
    all: () => ({ ...config }),
    set: async () => undefined,
  }

  const info = (missing: number, returned = 0): SaleInfo => ({
    sale: {
      id: SALE,
      invoice_no: 'INV-2026-000042',
      status: 'COMPLETED',
      created_at: '2026-09-26T10:00:00.000Z',
      customer: null,
    },
    lines: [
      {
        sale_item_id: 'item-1',
        product_id: 'p1',
        variant_id: 'v1',
        product_name: 'Phone',
        variant_name: '128GB',
        sku: null,
        unit_label: null,
        quantity: 2,
        returned_qty: returned,
        sold_units: 2 - returned,
        captured: 2 - missing - returned,
        bound: [],
        missing,
      },
    ],
    tracked: true,
    missing,
  })

  it('says a sale is settled when every unit has a number', async () => {
    answers.for_sale = info(0)
    const host = captureCard({ db: makeDb(), settings }, SALE)
    await settle()

    expect(textOf(host)).toContain('Every unit on this sale has a number')
  })

  it('attaches a scanned unit to the sale it is on', async () => {
    answers.for_sale = info(2)
    answers.capture = { sale_id: SALE, captured: 1, refusals: [], lines: [], missing: 1 } satisfies CaptureResult

    const host = captureCard({ db: makeDb(), settings }, SALE)
    await settle()

    const box = host.querySelector<HTMLInputElement>('input')!
    box.value = '356938035643809'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()

    expect(calls.find((call) => call.fn === 'capture')?.args).toEqual({
      sale_id: SALE,
      serials: ['356938035643809'],
    })
  })

  it('offers internal codes by default, and stops when the shop clears the prefix', async () => {
    answers.for_sale = info(2)

    // The server's own default for `internal_prefix` is `SN-`, so a shop that
    // has never opened the settings still gets the offer its server would
    // accept.
    const byDefault = captureCard({ db: makeDb(), settings }, SALE)
    await settle()
    expect(textOf(byDefault)).toContain('Generate 2 code(s)')

    config.internal_prefix = ''
    const emptied = captureCard({ db: makeDb(), settings }, SALE)
    await settle()
    expect(textOf(emptied)).not.toContain('Generate')
  })

  it('offers to mark returned units, and names them', async () => {
    answers.for_sale = info(0, 1)
    answers.sync_refunds = { marked: 1, lines: 1 }

    const host = captureCard({ db: makeDb(), settings }, SALE)
    await settle()
    expect(textOf(host)).toContain('Units came back on a return')

    const mark = [...host.querySelectorAll('button')].find((button) =>
      textOf(button).includes('Mark returned')
    )
    mark?.click()
    await settle()

    expect(calls.find((call) => call.fn === 'sync_refunds')?.args).toEqual({ sale_id: SALE })
  })

  it('never claims a sale is settled when it could not be read', async () => {
    refuse = 'permission_denied: serial-numbers.view'
    const host = captureCard({ db: makeDb(), settings }, SALE)
    await settle()

    expect(textOf(host)).toContain('Serial numbers could not be read')
    expect(textOf(host)).toContain('your role does not allow this')
  })
})

// ── The shop-wide screen ──────────────────────────────────────────────────

describe('the screen', () => {
  const overview: Overview = {
    totals: { total: 3, in_stock: 1, sold: 2, returned: 0, internal: 0 },
    tracked_products: 1,
    pending: { sales: 1, units: 2, window_days: 60, scanned: 50 },
    recent: [
      {
        id: 's1',
        serial: '356938035643809',
        status: 'SOLD',
        product_name: 'Phone',
        invoice_no: 'INV-2026-000042',
        sold_at: '2026-09-26T10:00:00.000Z',
        created_at: '2026-09-20T10:00:00.000Z',
      },
    ],
    config: { require_capture: true, internal_prefix: 'SN-', allow_over_stock: false },
  }

  const settings: PluginSettings = {
    get: <T,>(_key: string, fallback: T): T => fallback,
    all: () => ({}),
    set: async () => undefined,
  }

  /** Everything the screen reads, arranged the way the server would answer. */
  function arrange(): void {
    answers.overview = overview
    answers.catalog = {
      products: [{ id: 'p1', name: 'Phone', sku: 'PH-1', variants: 1, serials: 3, in_stock: 1 }],
      warehouses: [{ id: 'w1', name: 'Floor', code: 'FLOOR', is_retail_floor: true }],
      config: overview.config,
    }
    answers.variants = {
      variants: [
        {
          id: 'v1',
          name: '128GB',
          sku: null,
          is_default: true,
          is_active: true,
          on_hand: 4,
          serials: 3,
          in_stock: 1,
        },
      ],
    }
    answers.list = { rows: [], total: 0, limit: 50, offset: 0, status: '' }
    answers.pending = [
      {
        sale_id: SALE,
        invoice_no: 'INV-2026-000042',
        status: 'COMPLETED',
        created_at: '2026-09-26T10:00:00.000Z',
        customer: null,
        missing: 2,
        lines: [],
      },
    ]
    answers.report = {
      window: { days: 30, from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: { sold: 2, returned: 0, in_stock: 1, internal: 0, total: 3 },
      aging: [{ bucket: '0-30 days', count: 1 }],
      by_product: [{ product_id: 'p1', product_name: 'Phone', sold: 2, in_stock: 1 }],
      pending_sales: 1,
      pending_units: 2,
    }
  }

  async function open(): Promise<HTMLElement> {
    arrange()
    const db = makeDb()
    const page = createSerialsScreen({ db, settings })
    const host = await page.render({
      params: {},
      query: new URLSearchParams(),
      organizationId: ORG,
      organizationName: 'Test Shop',
      branchId: BRANCH,
      currency: 'BDT',
    })
    await settle()
    return host
  }

  it('asks its own server for everything it shows, in one pass', async () => {
    await open()
    expect(calls.map((call) => call.fn).sort()).toEqual([
      'catalog',
      'list',
      'overview',
      'pending',
      'report',
      'variants',
    ])
  })

  it('shows the four numbers a shop opens it for', async () => {
    const host = await open()
    const text = textOf(host)
    expect(text).toContain('In stock')
    expect(text).toContain('Left without a number')
    expect(text).toContain('2 units still need a number')
  })

  it('puts sales that need a number first, with the product that is missing one', async () => {
    const host = await open()
    expect(textOf(host)).toContain('Needs a number')
    expect(textOf(host)).toContain('INV-2026-000042')
  })

  it('registers a pasted delivery against the variant and warehouse chosen', async () => {
    const host = await open()
    answers.add = {
      added: 2,
      skipped: [{ serial: 'DUP', reason: 'already_registered' }],
      skipped_total: 1,
      variant_id: 'v1',
      warehouse_id: 'w1',
      in_stock: 3,
      stock_on_hand: 4,
      over_stock: false,
    }

    const box = host.querySelector<HTMLTextAreaElement>('textarea')!
    box.value = '356938035643809, 356938035643810\n356938035643811'
    const add = [...host.querySelectorAll('button')].find((button) =>
      textOf(button).includes('Add units')
    )
    add?.click()
    await settle()

    const call = calls.find((entry) => entry.fn === 'add')
    expect(call?.args).toEqual({
      variant_id: 'v1',
      warehouse_id: 'w1',
      serials: ['356938035643809', '356938035643810', '356938035643811'],
    })
    // The screen re-reads rather than patching its own numbers.
    expect(calls.filter((entry) => entry.fn === 'overview').length).toBeGreaterThan(1)
  })

  it('says what was skipped rather than failing the whole paste', async () => {
    const host = await open()
    answers.add = {
      added: 1,
      skipped: [{ serial: 'X', reason: 'over_stock' }],
      skipped_total: 1,
      variant_id: 'v1',
      warehouse_id: 'w1',
      in_stock: 2,
      stock_on_hand: 1,
      over_stock: false,
    }

    const box = host.querySelector<HTMLTextAreaElement>('textarea')!
    box.value = 'X\nY'
    ;[...host.querySelectorAll('button')].find((button) => textOf(button).includes('Add units'))?.click()
    await settle()

    expect(document.body.textContent ?? '').toContain('more units than the shop has in stock')
  })

  it('prints a sheet a shop can read while holding a handset', () => {
    const sheet = printableSheet('Serial numbers', [
      { serial: '356<938>035', product: 'Phone & case', when: '2026-09-26' },
    ])
    expect(sheet).toContain('356&lt;938&gt;035')
    expect(sheet).toContain('Phone &amp; case')
    expect(sheet).toContain('1 unit(s)')
  })
})

// ── The arithmetic the till does on its own ───────────────────────────────

describe('which line a scan belongs to', () => {
  const tracked = { [SERIAL_TRACKED_KEY]: true }
  const lines = [
    { variantId: 'v1', productId: 'p1', name: 'Phone', variantName: null, sku: null, quantity: 2, unitPrice: 1, metadata: tracked },
    { variantId: 'v2', productId: 'p1', name: 'Phone', variantName: 'Pro', sku: null, quantity: 1, unitPrice: 1, metadata: tracked },
  ]

  it('fills the line that still needs one', () => {
    const scan: PendingScan = { serial: 'A', variantId: 'v2', at: 1 }
    expect(lineForScan(lines, [scan])?.variantId).toBe('v1')
  })

  it('prefers the line with the most to do, so a two-unit line is filled first', () => {
    expect(lineForScan(lines, [])?.variantId).toBe('v1')
  })

  it('says nothing stays missing when every unit is scanned', () => {
    const scans: PendingScan[] = [
      { serial: 'A', variantId: 'v1', at: 1 },
      { serial: 'B', variantId: 'v1', at: 2 },
      { serial: 'C', variantId: 'v2', at: 3 },
    ]
    expect(tillSummary(lines, scans)).toEqual([
      { name: 'Phone', quantity: 2, scanned: 2, missing: 0 },
      { name: 'Phone — Pro', quantity: 1, scanned: 1, missing: 0 },
    ])
  })

  it('ignores lines whose product never asked to be tracked', () => {
    expect(trackedLines([{ ...lines[0]!, metadata: {} }])).toEqual([])
  })
})
