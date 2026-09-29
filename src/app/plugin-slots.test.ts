/**
 * The plugin slots the core draws (spec §31, §32, §51).
 *
 * These tests are about the contract between a feature and a plugin: a feature
 * asks for "the values to show here", and the answers depend on what a plugin
 * declared — `showInPOS` on the tile, `printable` on the receipt. Getting this
 * wrong is invisible in a shop with no plugins installed, which is exactly why
 * it is pinned.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PluginRegistry } from '../shared/registry/plugin-registry'
import { EventBus } from '../shared/bus'
import {
  containSaleAdjustmentQuote,
  containScanMatch,
  isPluginReportKey,
  panelLines,
  pluginReportKey,
  pluginReports,
  posFieldValues,
  posPrintSuppressions,
  printableNotes,
  resolveScan,
  runPluginReport,
} from './plugin-slots'
import { EMPTY_SESSION, sessionStore } from './state/session'
import { milli, minor } from '../shared/domain/money'
import { saleAdjustmentsHost } from './plugin-slots'
import type { CartLine } from '../shared/domain/cart'
import type {
  Plugin,
  PanelLine,
  SaleAdjustmentContext,
  SaleAdjustmentDefinition,
  ScanContext,
} from '../shared/registry/plugin-types'

function registryWith(plugin: Plugin): PluginRegistry {
  const bus = new EventBus()
  bus.onError = () => undefined
  const registry = new PluginRegistry(bus, {
    settings: () => ({ get: <T,>(_k: string, fallback: T): T => fallback, all: () => ({}), set: async () => undefined }),
    data: () => ({
      get: async <T,>(_k: string, fallback: T): Promise<T> => fallback,
      set: async () => undefined,
      remove: async () => false,
      keys: async () => [],
    }),
    db: () => ({ products: async () => [], rpc: async <T,>(): Promise<T> => null as T }),
  })
  registry.declare({
    manifest: {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      coreApiVersion: '^1.0.0',
      description: 'A plugin with fields on the till and the slip.',
      category: 'optional',
    },
    load: async () => plugin,
  })
  return registry
}

const plugin: Plugin = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  register: (api) => {
    api.registerProductField({
      key: 'demo.batch',
      label: 'Batch number',
      type: 'text',
      storage: 'metadata',
      showInPOS: true,
      printable: true,
    })
    api.registerProductField({
      key: 'demo.notes',
      label: 'Internal notes',
      type: 'text',
      storage: 'metadata',
    })
    api.registerProductField({
      key: 'demo.expiry',
      label: 'Expiry',
      type: 'date',
      storage: 'metadata',
      showInPOS: true,
      printable: true,
      format: (value) => `in ${String(value)} days`,
    })
  },
}

let registry: PluginRegistry

beforeEach(async () => {
  registry = registryWith(plugin)
  await registry.sync(['demo'])
  // Most slots here are not permission-gated; the report tests set their own.
  sessionStore.reset({ ...EMPTY_SESSION, permissions: ['*'] })
})

afterEach(() => {
  sessionStore.reset(EMPTY_SESSION)
})

describe('POS tile values', () => {
  it('shows only the fields the plugin asked to show there', () => {
    const values = posFieldValues(registry, {
      'demo.batch': 'BT-14',
      'demo.notes': 'never shown at the till',
      'demo.expiry': 30,
    })

    expect(values.map((entry) => entry.key)).toEqual(['demo.batch', 'demo.expiry'])
  })

  it('uses the plugin’s own formatter, so the till reads like the shop writes', () => {
    const values = posFieldValues(registry, { 'demo.expiry': 30 })
    expect(values[0]?.text).toBe('in 30 days')
  })

  it('skips a field the product has no value for', () => {
    expect(posFieldValues(registry, {})).toEqual([])
    expect(posFieldValues(registry, { 'demo.batch': null })).toEqual([])
  })
})

describe('receipt notes', () => {
  it('collects the printable values per variant, labelled', () => {
    const notes = printableNotes(registry, [
      { variantId: 'v1', metadata: { 'demo.batch': 'BT-14', 'demo.expiry': 12, 'demo.notes': 'ignored' } },
      { variantId: 'v2', metadata: {} },
    ])

    expect(notes.get('v1')).toEqual(['Batch number: BT-14', 'Expiry: in 12 days'])
    expect(notes.has('v2')).toBe(false)
  })

  it('prints nothing at all when no plugin asks to', async () => {
    const bare = registryWith({ ...plugin, register: () => undefined })
    await bare.sync(['demo'])

    const notes = printableNotes(bare, [{ variantId: 'v1', metadata: { anything: 'x' } }])
    expect([...notes.keys()]).toEqual([])
  })

  it('stops printing a field the moment its plugin is switched off', async () => {
    await registry.sync([])
    const notes = printableNotes(registry, [{ variantId: 'v1', metadata: { 'demo.batch': 'BT-14' } }])
    expect([...notes.keys()]).toEqual([])
  })

  it('leaves off a field a line was told to suppress, and only for that line', () => {
    const suppressed = new Map([['v1', new Set(['demo.batch'])]])
    const notes = printableNotes(
      registry,
      [
        { variantId: 'v1', metadata: { 'demo.batch': 'BT-14', 'demo.expiry': 12 } },
        { variantId: 'v2', metadata: { 'demo.batch': 'BT-99', 'demo.expiry': 6 } },
      ],
      suppressed
    )

    // v1 chose not to print the batch; its expiry still prints.
    expect(notes.get('v1')).toEqual(['Expiry: in 12 days'])
    // v2 was not touched, so it prints in full.
    expect(notes.get('v2')).toEqual(['Batch number: BT-99', 'Expiry: in 6 days'])
  })

  it('drops the line entirely when every printable field on it is suppressed', () => {
    const suppressed = new Map([['v1', new Set(['demo.batch', 'demo.expiry'])]])
    const notes = printableNotes(
      registry,
      [{ variantId: 'v1', metadata: { 'demo.batch': 'BT-14', 'demo.expiry': 12 } }],
      suppressed
    )
    expect(notes.has('v1')).toBe(false)
  })
})

describe('receipt suppressions a POS panel asks for', () => {
  async function registryWithPanels(
    panels: readonly {
      id: string
      suppress?: () => ReadonlyMap<string, readonly string[]>
    }[]
  ): Promise<PluginRegistry> {
    const reg = registryWith({
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      register: (api) => {
        for (const panel of panels) {
          api.registerPOSPanel({
            id: panel.id,
            label: 'Cover',
            render: () => document.createElement('div'),
            ...(panel.suppress ? { suppressPrintFields: panel.suppress } : {}),
          })
        }
      },
    })
    await reg.sync(['demo'])
    return reg
  }

  it('is empty when no panel asks for anything', async () => {
    const reg = await registryWithPanels([{ id: 'p.one' }])
    expect(posPrintSuppressions(reg).size).toBe(0)
  })

  it('merges the variants and field keys every panel wants left off the slip', async () => {
    const reg = await registryWithPanels([
      { id: 'p.one', suppress: () => new Map([['v1', ['warranty_months']]]) },
      {
        id: 'p.two',
        suppress: () =>
          new Map([
            ['v1', ['serial']],
            ['v2', ['warranty_months']],
          ]),
      },
    ])

    const merged = posPrintSuppressions(reg)
    expect(merged.get('v1')).toEqual(new Set(['warranty_months', 'serial']))
    expect(merged.get('v2')).toEqual(new Set(['warranty_months']))
  })
})

// ── The cart a plugin is shown ────────────────────────────────────────────
//
// A POS panel that decorates the sale in front of the cashier has to know what
// is on it. The projection is the contract: what a plugin sees, and — just as
// importantly — what it does not.

function cartLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    lineId: 'line-1',
    variantId: 'v1',
    productId: 'p1',
    name: 'Soap',
    variantName: null,
    sku: 'SOAP-1',
    unitLabel: null,
    unitPrice: minor(12000),
    unitCost: 800000,
    taxRatePercent: 0,
    taxInclusive: false,
    trackStock: true,
    allowNegative: false,
    availableQty: milli(5000),
    decimalQuantity: false,
    quantity: milli(2000),
    discountType: null,
    discountValue: 0,
    ...overrides,
  }
}

describe('the cart a plugin is shown', () => {
  it('gives a plugin plain numbers, and the product’s own metadata', () => {
    const lines = panelLines([cartLine()], () => ({
      metadata: { serial_tracked: true, batch_number: 'BT-14' },
    }))

    expect(lines).toEqual<PanelLine[]>([
      {
        variantId: 'v1',
        productId: 'p1',
        name: 'Soap',
        variantName: null,
        sku: 'SOAP-1',
        quantity: 2,
        unitPrice: 120,
        metadata: { serial_tracked: true, batch_number: 'BT-14' },
      },
    ])
  })

  it('keeps a weighed line honest: 1.25 kg arrives as 1.25', () => {
    const lines = panelLines([cartLine({ quantity: milli(1250) })], () => ({ metadata: {} }))
    expect(lines[0]?.quantity).toBe(1.25)
  })

  it('falls back to no metadata for a variant the till has not seen', () => {
    // A plugin reads `metadata.serial_tracked`; an empty object means "not
    // tracked", and a plugin must never read it as "tracked by default".
    const lines = panelLines([cartLine()], () => undefined)
    expect(lines[0]?.metadata).toEqual({})
  })

  it('hands over nothing a plugin could write back', () => {
    const [line] = panelLines([cartLine()], () => ({ metadata: {} }))
    expect(Object.keys(line ?? {}).sort()).toEqual([
      'metadata',
      'name',
      'productId',
      'quantity',
      'sku',
      'unitPrice',
      'variantId',
      'variantName',
    ])
  })
})

// ── Reports ───────────────────────────────────────────────────────────────
//
// The seam that makes a plugin's report visible in the core reports screen.
// These tests are about what the *host* owes the plugin: a key that cannot
// collide, permission filtering, and a finished `ReportResult` the table and
// the exporters can both read.

const reportPlugin: Plugin = {
  id: 'demo',
  name: 'Demo Kit',
  version: '1.0.0',
  register: (api) => {
    api.registerReport({
      id: 'expiring',
      label: 'Expiring stock',
      icon: 'event_busy',
      permission: 'inventory.view',
      description: 'What is about to go off.',
      filters: { window: true, search: true },
      run: (context) => ({
        columns: [
          { key: 'product', label: 'Product', type: 'text' },
          { key: 'days', label: 'Days left', type: 'int', align: 'right' },
          { key: 'tags', label: 'Tags', type: 'text' },
        ],
        rows: [
          { product: 'Paracetamol', days: 3, secret: 'not a column' },
          // Deliberately illegal: a plugin returning something that is not a
          // cell is contained, not rendered as `[object Object]`.
          { product: 'Amoxicillin', days: -2, tags: ['rx', 'cold'] as unknown as string },
          { product: 'Ibuprofen', days: 9, tags: 42 },
        ],
        totals: { days: 10, secret: 99, product: Number.NaN, tags: Number.POSITIVE_INFINITY },
        note: 'inside 30 day(s)',
        ...(context.period === 'year' ? { currency: 'USD' } : {}),
      }),
    })
    api.registerReport({
      id: 'aging',
      label: 'Serial aging',
      icon: 'hourglass_bottom',
      filters: { window: false },
      run: () => ({ columns: [{ key: 'bucket', label: 'Bucket', type: 'text' }], rows: [] }),
    })
    api.registerReport({
      id: 'secret',
      label: 'Salary review',
      icon: 'lock',
      permission: 'payroll.view',
      run: () => ({ columns: [], rows: [] }),
    })
  },
}

async function hostWithReports(): Promise<PluginRegistry> {
  const other = registryWith(reportPlugin)
  await other.sync(['demo'])
  return other
}

const context = {
  period: 'month',
  from: null,
  to: null,
  search: '',
  branchId: 'b1',
  limit: 25,
  offset: 0,
}

describe('the reports a plugin contributes', () => {
  it('gives each one a key that cannot collide with a server report', async () => {
    const host = await hostWithReports()
    expect(pluginReports(host).map((report) => report.key)).toEqual([
      'plugin.demo.expiring',
      'plugin.demo.aging',
      'plugin.demo.secret',
    ])
    expect(pluginReportKey('demo', 'expiring')).toBe('plugin.demo.expiring')
    expect(isPluginReportKey('plugin.demo.expiring')).toBe(true)
    expect(isPluginReportKey('sales')).toBe(false)
  })

  it('groups by the plugin’s name unless the report asked for a group', async () => {
    const host = await hostWithReports()
    const [expiring, aging] = pluginReports(host)
    expect(expiring?.group).toBe('Demo')
    expect(aging?.label).toBe('Serial aging')
  })

  it('defaults to windowed and not searchable', async () => {
    const host = await hostWithReports()
    const aging = pluginReports(host).find((report) => report.id === 'aging')
    expect(aging?.filters).toEqual({ window: false, search: false })
  })

  it('hides a report whose permission the user lacks', async () => {
    const host = await hostWithReports()
    sessionStore.reset({ ...EMPTY_SESSION, permissions: ['inventory.view'] })
    expect(pluginReports(host).map((report) => report.id)).toEqual(['expiring', 'aging'])

    sessionStore.reset({ ...EMPTY_SESSION, permissions: ['*'] })
    expect(pluginReports(host).map((report) => report.id)).toContain('secret')
  })
})

describe('running one', () => {
  async function expiring() {
    const host = await hostWithReports()
    const report = pluginReports(host).find((entry) => entry.id === 'expiring')
    return { host, report: report! }
  }

  it('fills in what the host owns and leaves the plugin’s own facts alone', async () => {
    const { report } = await expiring()
    const result = await runPluginReport(report, context, {
      currency: 'BDT',
      periodLabel: 'This month',
    })

    expect(result.key).toBe('plugin.demo.expiring')
    expect(result.title).toBe('Expiring stock')
    expect(result.description).toBe('What is about to go off.')
    expect(result.currency).toBe('BDT')
    expect(result.period).toBe('month')
    expect(result.limit).toBe(25)
    expect(result.offset).toBe(0)
    expect(result.label).toBe('This month · inside 30 day(s)')
    expect(result.totalRows).toBe(3)
    // A plugin report is not sorted by the host: its rows may not even be in
    // this browser, so the headers are labels rather than buttons.
    expect(result.sort).toBe('')
  })

  it('keeps the plugin’s currency when it names one', async () => {
    const { report } = await expiring()
    const result = await runPluginReport(report, { ...context, period: 'year' }, { currency: 'BDT' })
    expect(result.currency).toBe('USD')
  })

  it('clips the rows to the page the host asked for', async () => {
    const { report } = await expiring()
    const result = await runPluginReport(report, { ...context, limit: 2 }, { currency: 'BDT' })
    expect(result.rows).toHaveLength(2)
    expect(result.totalRows).toBe(3)
    expect(result.limit).toBe(2)
  })

  it('drops a cell no column claims, and makes text of what is not scalar', async () => {
    const { report } = await expiring()
    const result = await runPluginReport(report, context, { currency: 'BDT' })

    // A stray key would otherwise reach the CSV…
    expect(result.rows[0]).toEqual({ product: 'Paracetamol', days: 3 })
    // …and an array cell becomes readable text rather than nothing at all.
    expect(result.rows[1]).toEqual({ product: 'Amoxicillin', days: -2, tags: 'rx,cold' })
    expect(result.rows[2]).toEqual({ product: 'Ibuprofen', days: 9, tags: 42 })
  })

  it('keeps only finite totals, and only for columns that exist', async () => {
    const { report } = await expiring()
    const result = await runPluginReport(report, context, { currency: 'BDT' })
    expect(result.totals).toEqual({ days: 10 })
  })

  it('claims no window for a report that declared it has none', async () => {
    const host = await hostWithReports()
    const aging = pluginReports(host).find((entry) => entry.id === 'aging')!
    const result = await runPluginReport(aging, context, {
      currency: 'BDT',
      periodLabel: 'This month',
    })
    expect(result.label).toBe('All rows')
    expect(result.rows).toEqual([])
  })

  it('lets a plugin’s failure reach the screen, which knows how to report it', async () => {
    const broken = registryWith({
      ...reportPlugin,
      register: (api) => {
        api.registerReport({
          id: 'boom',
          label: 'Boom',
          icon: 'error',
          run: () => {
            throw new Error('the batch table is not there')
          },
        })
      },
    })
    await broken.sync(['demo'])
    const report = pluginReports(broken)[0]!

    await expect(runPluginReport(report, context, { currency: 'BDT' })).rejects.toThrow(
      'the batch table is not there'
    )
  })
})

// ── Scan resolvers ────────────────────────────────────────────────────────
// The middle step of the till's three-step scan resolution: barcode table,
// plugins, search. A plugin here is what turns a scale label — a code the shop
// will never have in its barcode table — into a sale.

const SCAN_CONTEXT: ScanContext = {
  organizationId: 'org-1',
  branchId: 'b-1',
  warehouseId: 'w-1',
  currency: 'BDT',
}

/** A plugin whose resolver answers for codes starting with `22`. */
function resolverPlugin(
  id: string,
  resolve: Plugin['register'] extends never ? never : (code: string, context: ScanContext) => unknown,
  options: { permission?: string; label?: string } = {}
): Plugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    register: (api) => {
      api.registerScanResolver({
        id: `${id}.scan`,
        label: options.label ?? 'Weighing scale',
        ...(options.permission ? { permission: options.permission } : {}),
        resolve: (code, context) => resolve(code, context) as never,
      })
    },
  }
}

describe('scan resolvers', () => {
  it('gives the first plugin that claims a code the answer, and nobody else', async () => {
    const asked: string[] = []
    const first = new PluginRegistry(new EventBus(), {
      settings: () => ({ get: <T,>(_k: string, fallback: T): T => fallback, all: () => ({}), set: async () => undefined }),
      data: () => ({ get: async <T,>(_k: string, fallback: T): Promise<T> => fallback, set: async () => undefined, remove: async () => false, keys: async () => [] }),
      db: () => ({ products: async () => [], rpc: async <T,>(): Promise<T> => null as T }),
    })
    first.declare({
      manifest: { id: 'a', name: 'A', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () =>
        resolverPlugin('a', (code) => {
          asked.push(`a:${code}`)
          return { lookupCode: '12340', quantity: 2.35 }
        }),
    })
    first.declare({
      manifest: { id: 'b', name: 'B', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () =>
        resolverPlugin('b', (code) => {
          asked.push(`b:${code}`)
          return { lookupCode: '99999' }
        }),
    })
    await first.sync(['a', 'b'])

    const hit = await resolveScan(first, '2212340007504', SCAN_CONTEXT)
    expect(hit?.source).toBe('a')
    expect(hit?.label).toBe('Weighing scale')
    expect(hit?.match).toEqual({ lookupCode: '12340', quantity: 2.35 })
    // The second plugin is never asked: a code has one meaning.
    expect(asked).toEqual(['a:2212340007504'])
  })

  it('passes over a plugin that says no, and over one that throws', async () => {
    const busy = new PluginRegistry(new EventBus(), {
      settings: () => ({ get: <T,>(_k: string, fallback: T): T => fallback, all: () => ({}), set: async () => undefined }),
      data: () => ({ get: async <T,>(_k: string, fallback: T): Promise<T> => fallback, set: async () => undefined, remove: async () => false, keys: async () => [] }),
      db: () => ({ products: async () => [], rpc: async <T,>(): Promise<T> => null as T }),
    })
    busy.declare({
      manifest: { id: 'boom', name: 'Boom', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () =>
        resolverPlugin('boom', () => {
          throw new Error('the scale table is not there')
        }),
    })
    busy.declare({
      manifest: { id: 'quiet', name: 'Quiet', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () => resolverPlugin('quiet', () => null),
    })
    busy.declare({
      manifest: { id: 'later', name: 'Later', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () => resolverPlugin('later', () => ({ lookupCode: '40404' })),
    })
    await busy.sync(['boom', 'quiet', 'later'])

    // A misbehaving add-on costs the shop a decoration, not a sale.
    const hit = await resolveScan(busy, '2212340007504', SCAN_CONTEXT)
    expect(hit?.source).toBe('later')
    expect(hit?.match.lookupCode).toBe('40404')
  })

  it('never asks a plugin whose permission the cashier does not hold', async () => {
    const refused = new PluginRegistry(new EventBus(), {
      settings: () => ({ get: <T,>(_k: string, fallback: T): T => fallback, all: () => ({}), set: async () => undefined }),
      data: () => ({ get: async <T,>(_k: string, fallback: T): Promise<T> => fallback, set: async () => undefined, remove: async () => false, keys: async () => [] }),
      db: () => ({ products: async () => [], rpc: async <T,>(): Promise<T> => null as T }),
    })
    let asked = 0
    refused.declare({
      manifest: { id: 'gated', name: 'Gated', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () =>
        resolverPlugin(
          'gated',
          () => {
            asked += 1
            return { lookupCode: '1' }
          },
          { permission: 'weight-scale.view' }
        ),
    })
    await refused.sync(['gated'])

    sessionStore.reset({ ...EMPTY_SESSION, permissions: ['sales.create'] })
    expect(await resolveScan(refused, '2212340007504', SCAN_CONTEXT)).toBeNull()
    expect(asked).toBe(0)

    sessionStore.reset({ ...EMPTY_SESSION, permissions: ['weight-scale.view', 'sales.create'] })
    expect((await resolveScan(refused, '2212340007504', SCAN_CONTEXT))?.match.lookupCode).toBe('1')
    expect(asked).toBe(1)
  })

  it('contains what a plugin hands back before the cart sees it', () => {
    // A lookup code is the one thing that cannot be defaulted.
    expect(containScanMatch(null)).toBeNull()
    expect(containScanMatch({ lookupCode: '   ' })).toBeNull()
    expect(containScanMatch({ lookupCode: ' 12340 ' })).toEqual({ lookupCode: '12340' })

    // A line that cannot be added is better than a line added wrongly.
    expect(containScanMatch({ lookupCode: '1', quantity: 0 })).toEqual({ lookupCode: '1' })
    expect(containScanMatch({ lookupCode: '1', quantity: -2 })).toEqual({ lookupCode: '1' })
    expect(containScanMatch({ lookupCode: '1', quantity: Number.NaN })).toEqual({ lookupCode: '1' })
    expect(containScanMatch({ lookupCode: '1', unitPriceMinor: 12.5 })).toEqual({ lookupCode: '1' })
    expect(containScanMatch({ lookupCode: '1', unitPriceMinor: -1 })).toEqual({ lookupCode: '1' })
    expect(containScanMatch({ lookupCode: '1', note: '   ' })).toEqual({ lookupCode: '1' })

    expect(
      containScanMatch({ lookupCode: ' 12340 ', quantity: 2.35, unitPriceMinor: 12000, note: ' 2.350 kg ' })
    ).toEqual({ lookupCode: '12340', quantity: 2.35, unitPriceMinor: 12000, note: '2.350 kg' })
  })

  it('reads nothing into an empty scan', async () => {
    await registry.sync(['demo'])
    expect(await resolveScan(registry, '   ', SCAN_CONTEXT)).toBeNull()
  })
})

describe('sale adjustments', () => {
  const context: SaleAdjustmentContext = {
    organizationId: 'org-1',
    branchId: 'b-1',
    currency: 'BDT',
    customerId: 'c-1',
    totalMinor: 20000,
  }

  /** The loaded module's id must be the declared manifest's id — hence the id. */
  function adjustmentPlugin(
    id: string,
    definition: Partial<SaleAdjustmentDefinition> & Pick<SaleAdjustmentDefinition, 'quote'>
  ): Plugin {
    return {
      id,
      name: 'Adjust',
      version: '1.0.0',
      register: (api) => {
        api.registerSaleAdjustment({
          id: 'adjust.redeem',
          label: 'Loyalty',
          ...definition,
        })
      },
    }
  }

  const settle = async (rounds = 6): Promise<void> => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('contains what a plugin calls money before the sale sees it', () => {
    // Money is whole minor units. Anything else is not a discount.
    expect(containSaleAdjustmentQuote(null)).toBeNull()
    expect(containSaleAdjustmentQuote({ amountMinor: 0, label: 'Free' })).toBeNull()
    expect(containSaleAdjustmentQuote({ amountMinor: -5000, label: 'Refund' })).toBeNull()
    expect(containSaleAdjustmentQuote({ amountMinor: 12.5, label: 'Paisa' })).toBeNull()
    expect(containSaleAdjustmentQuote({ amountMinor: 5000, label: '   ' })).toBeNull()
    // …and a NaN cannot be smuggled through a comparison.
    expect(containSaleAdjustmentQuote({ amountMinor: Number.NaN, label: 'x' })).toBeNull()

    expect(containSaleAdjustmentQuote({ amountMinor: 5000, label: ' 500 points ', note: ' ', token: ' rd-1 ' })).toEqual({
      amountMinor: 5000,
      label: '500 points',
      token: 'rd-1',
    })
  })

  it('asks the plugin, then hands the cashier what it said', async () => {
    const asked: SaleAdjustmentContext[] = []
    const registry = registryWith(
      adjustmentPlugin('demo', {
        quote: (seen) => {
          asked.push(seen)
          return { amountMinor: 5000, label: 'Redeem 500 points', note: '500 points · ৳50.00 off' }
        },
      })
    )
    await registry.sync(['demo'])

    const applied: string[] = []
    const host = saleAdjustmentsHost(registry, context, {
      applied: [],
      onApply: (_definition, quote) => applied.push(quote.token ?? quote.label),
      onRemove: () => undefined,
    })
    document.body.append(host)
    await settle()

    expect(asked).toEqual([context])
    expect(host.textContent).toContain('Redeem 500 points')
    expect(host.textContent).toContain('500 points · ৳50.00 off')
    host.querySelector('button')?.click()
    expect(applied).toEqual(['Redeem 500 points'])
  })

  it('withdraws what it already gave when the sale shrinks under it', async () => {
    // The redemption was for the whole cart; the cart is now worth ৳50.
    const registry = registryWith(
      adjustmentPlugin('demo', {
        quote: () => ({ amountMinor: 20000, label: 'Redeem 2000 points', token: 'rd' }),
      })
    )
    await registry.sync(['demo'])

    const released: string[] = []
    const host = saleAdjustmentsHost(registry, { ...context, totalMinor: 5000 }, {
      applied: [
        {
          id: 'adjust.redeem',
          source: 'adjust',
          quote: { amountMinor: 20000, label: 'Redeem 2000 points', token: 'rd' },
        },
      ],
      onApply: () => undefined,
      onRemove: (_definition, _quote, reason) => released.push(reason),
    })
    document.body.append(host)
    await settle()

    expect(released).toEqual(['invalid'])
    // Nothing to press: the offer is gone with the sale it was quoted for.
    expect(host.textContent).not.toContain('Remove')
  })

  it('does not re-price an applied adjustment, and does not hide one either', async () => {
    // The plugin now offers less — but the customer was already charged for the
    // ৳50 they were promised. Withdrawing it is the cashier's call, not the
    // plugin's, so the applied row stays and the plugin is told nothing.
    const registry = registryWith(
      adjustmentPlugin('demo', {
        quote: () => ({ amountMinor: 1000, label: 'Redeem 100 points' }),
      })
    )
    await registry.sync(['demo'])

    const released: string[] = []
    const host = saleAdjustmentsHost(registry, context, {
      applied: [
        { id: 'adjust.redeem', source: 'adjust', quote: { amountMinor: 5000, label: 'Redeem 500 points' } },
      ],
      onApply: () => undefined,
      onRemove: () => released.push('released'),
    })
    document.body.append(host)
    await settle()

    expect(released).toEqual([])
    expect(host.textContent).toContain('Redeem 500 points')
    expect(host.textContent).toContain('Remove')
  })

  it('costs the shop a decoration, not a sale, when a plugin throws while quoting', async () => {
    const broken = new PluginRegistry(new EventBus(), {
      settings: () => ({ get: <T,>(_k: string, fallback: T): T => fallback, all: () => ({}), set: async () => undefined }),
      data: () => ({ get: async <T,>(_k: string, fallback: T): Promise<T> => fallback, set: async () => undefined, remove: async () => false, keys: async () => [] }),
      db: () => ({ products: async () => [], rpc: async <T,>(): Promise<T> => null as T }),
    })
    broken.declare({
      manifest: { id: 'boom', name: 'Boom', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () =>
        adjustmentPlugin('boom', {
          quote: () => {
            throw new Error('the points table is not there')
          },
        }),
    })
    broken.declare({
      manifest: { id: 'fine', name: 'Fine', version: '1.0.0', coreApiVersion: '^1.0.0', description: '', category: 'optional' },
      load: async () =>
        adjustmentPlugin('fine', {
          id: 'fine.redeem',
          quote: () => ({ amountMinor: 2500, label: 'Redeem 250 points' }),
        }),
    })
    await broken.sync(['boom', 'fine'])

    const host = saleAdjustmentsHost(broken, context, {
      applied: [],
      onApply: () => undefined,
      onRemove: () => undefined,
    })
    document.body.append(host)
    await settle()

    // The shopkeeper is told which add-on is unwell, and the one beside it
    // still works.
    expect(host.textContent).toContain('could not')
    expect(host.textContent).toContain('Redeem 250 points')
  })

  it('never asks a plugin whose permission the cashier does not hold', async () => {
    let asked = 0
    const registry = registryWith(
      adjustmentPlugin('demo', {
        permission: 'loyalty.redeem',
        quote: () => {
          asked += 1
          return { amountMinor: 5000, label: 'Redeem 500 points' }
        },
      })
    )
    await registry.sync(['demo'])

    sessionStore.reset({ ...EMPTY_SESSION, permissions: ['sales.create'] })
    const host = saleAdjustmentsHost(registry, context, {
      applied: [],
      onApply: () => undefined,
      onRemove: () => undefined,
    })
    document.body.append(host)
    await settle()

    expect(asked).toBe(0)
    expect(host.textContent).toBe('')
  })
})
