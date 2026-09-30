/**
 * Warranty — tested through the public plugin API.
 *
 * What matters is not that a card renders but that the plugin behaves the way a
 * shop needs it to: a promise is written once and only when the sale is real,
 * nothing is silently lost when the shop's server refuses, a claim moves only
 * where the server allows, and money reaches the till as minor units. The SQL
 * itself is exercised against a real Postgres by the live probe and the
 * migration validator; these tests are about the half that runs in a browser.
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
import { formatMoney, minor } from '../../shared/domain/money'
import warrantyPlugin, { horizonDays, windowDates } from './index'
import { coverCard } from './cover-card'
import { create as createWarrantyScreen } from './warranty-screen'
import {
  AUTO_REGISTER_KEY,
  CLAIM_PREFIX_KEY,
  COVER_ALL_KEY,
  DEFAULT_AUTO_REGISTER,
  DEFAULT_CLAIM_PREFIX,
  DEFAULT_COVER_ALL,
  DEFAULT_MONTHS,
  DEFAULT_MONTHS_KEY,
  DEFAULT_WARN_DAYS,
  LAST_SALE_KEY,
  WARN_DAYS_KEY,
  WARRANTY_MANAGE,
  WARRANTY_MONTHS_KEY,
  WARRANTY_VIEW,
  warrantyManifest,
} from './manifest'
import {
  certificate,
  claimStatusLabel,
  claimTone,
  costToMinor,
  coverageLabel,
  coverageOf,
  coveredLines,
  daysLeftLabel,
  describeError,
  endDateFor,
  missingCoverLabel,
  moneyLabel,
  monthsFromProduct,
  monthsLabel,
  nextClaimStatuses,
  reasonLabel,
  tillSummary,
  unitLabel,
  type ClaimPage,
  type ClaimRow,
  type ClaimsReport,
  type ExpiringReport,
  type Overview,
  type PendingQueue,
  type RegisterResult,
  type SaleCover,
  type UnitPage,
  type UnitRow,
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
let errors: unknown[] = []
let config: Record<string, unknown> = {}

function makeDb(): PluginDb {
  return {
    products: async () => [],
    rpc: async <T,>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ fn, args })
      if (refuse) throw new Error(refuse)
      const answer = answers[fn]
      if (typeof answer === 'function') {
        return (answer as (args: Record<string, unknown>) => unknown)(args) as T
      }
      return (answer ?? null) as T
    },
  }
}

function settingsStore(): PluginSettings {
  return {
    get: <T,>(key: string, fallback: T): T => (key in config ? (config[key] as T) : fallback),
    all: () => ({ ...config }),
    set: async (key, value) => {
      config[key] = value
    },
  }
}

beforeEach(() => {
  calls = []
  answers = {}
  refuse = null
  errors = []
  config = {}
  localStorage.clear()
  bus = new EventBus()
  bus.onError = (error) => errors.push(error)

  const dataStore: PluginDataStore = {
    get: async <T,>(_key: string, fallback: T): Promise<T> => fallback,
    set: async () => undefined,
    remove: async () => false,
    keys: async () => [],
  }

  registry = new PluginRegistry(bus, {
    settings: () => settingsStore(),
    data: () => dataStore,
    db: () => makeDb(),
  })
  registry.declare({ manifest: warrantyManifest, load: async () => warrantyPlugin })
})

/** Waits for the promises a render or a handler kicked off. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const textOf = (node: Element): string => node.textContent ?? ''

/** Clicks the first button whose visible text says this. */
function press(root: Element, label: string): void {
  const button = [...root.querySelectorAll('button')].find((entry) =>
    (entry.textContent ?? '').trim().toLowerCase().includes(label.toLowerCase())
  )
  if (!button) throw new Error(`no button reading “${label}” — saw: ${[...root.querySelectorAll('button')].map((entry) => entry.textContent?.trim()).join(', ')}`)
  button.click()
}

// ── Fixtures ──────────────────────────────────────────────────────────────

function unitRow(index: number, over: Partial<UnitRow> = {}): UnitRow {
  return {
    id: `w${index}`,
    product_id: 'p1',
    product_name: 'Fridge 320L',
    variant_name: null,
    unit_label: null,
    unit_index: index,
    months: 12,
    provider: 'SHOP',
    terms: null,
    starts_on: '2026-09-01',
    ends_on: '2027-09-01',
    days_left: 340,
    status: 'ACTIVE',
    void_reason: null,
    voided_at: null,
    note: null,
    created_at: '2026-09-01T10:00:00.000Z',
    customer: 'Rahim Uddin',
    customer_phone: '01711000000',
    customer_id: null,
    invoice_no: 'INV-2026-000042',
    sale_id: SALE,
    sale_status: 'COMPLETED',
    sold_on: '2026-09-01',
    claims_count: 0,
    claim: null,
    ...over,
  }
}

function claimRow(index: number, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: `c${index}`,
    claim_no: `WC-2026-${String(index).padStart(6, '0')}`,
    status: 'OPEN',
    opened_on: '2026-09-10',
    closed_on: null,
    cost_minor: 0,
    issue: 'compressor noisy',
    resolution: null,
    days_open: 16,
    warranty_id: `w${index}`,
    product_name: 'Fridge 320L',
    variant_name: null,
    unit_label: null,
    unit_index: index,
    months: 12,
    starts_on: '2026-09-01',
    ends_on: '2027-09-01',
    warranty_status: 'ACTIVE',
    covered_until_days: 340,
    sale_id: SALE,
    invoice_no: 'INV-2026-000042',
    customer: 'Rahim Uddin',
    customer_phone: '01711000000',
    ...over,
  }
}

function coverFixture(over: Partial<SaleCover> = {}): SaleCover {
  return {
    sale: {
      id: SALE,
      invoice_no: 'INV-2026-000042',
      status: 'COMPLETED',
      sold_on: '2026-09-01',
      customer: 'Rahim Uddin',
    },
    today: '2026-09-26',
    lines: [
      {
        sale_item_id: 'item-1',
        product_id: 'p1',
        variant_id: 'v1',
        product_name: 'Fridge 320L',
        variant_name: null,
        sku: 'FR-320',
        unit_label: null,
        quantity: 1,
        returned_qty: 0,
        sold_units: 1,
        months: 12,
        registered: 0,
        missing: 1,
      },
    ],
    units: [],
    missing: 1,
    ...over,
  }
}

function overviewFixture(over: Partial<Overview> = {}): Overview {
  return {
    totals: {
      units: 6,
      active: 4,
      expiring: 1,
      expired: 1,
      void: 1,
      products: 3,
      claims_total: 2,
      claims_open: 1,
      claims_cost_minor: 250000,
      claims_cost_open_minor: 50000,
    },
    recent: [
      {
        id: 'w1',
        product_name: 'Fridge 320L',
        unit_label: null,
        unit_index: 1,
        months: 12,
        ends_on: '2027-09-01',
        days_left: 340,
        status: 'ACTIVE',
        invoice_no: 'INV-2026-000042',
        customer: 'Rahim Uddin',
      },
    ],
    today: '2026-09-26',
    pending: { sales: 1, units: 2, window_days: 60 },
    config: { cover_all_lines: false, default_months: 12, warn_days: 30, claim_prefix: 'WC-' },
    ...over,
  }
}

function cartLine(over: Partial<PanelLine> = {}): PanelLine[] {
  return [
    {
      variantId: 'v1',
      productId: 'p1',
      name: 'Fridge 320L',
      variantName: null,
      sku: 'FR-320',
      quantity: 1,
      unitPrice: 5500000,
      metadata: { [WARRANTY_MONTHS_KEY]: 24 },
      ...over,
    },
  ]
}

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
    total: '55000.00',
    ...overrides,
  },
})

// ── The manifest ──────────────────────────────────────────────────────────

describe('manifest', () => {
  it('is valid, and would be refused if it minted a core permission', () => {
    // `validateManifest` throws rather than returning problems, so the app can
    // refuse a plugin at the door instead of half-loading it.
    expect(() => validateManifest(warrantyManifest)).not.toThrow()
    expect(() =>
      validateManifest({
        ...warrantyManifest,
        permissions: [{ key: 'sales.view', label: 'Sneak', group: 'service' }],
      })
    ).toThrow(/sales\.view/)
  })

  it('namespaces every permission to the plugin, and asks for no core API it was not given', () => {
    const keys = (warrantyManifest.permissions ?? []).map((entry) => entry.key)
    expect(keys).toEqual([WARRANTY_VIEW, WARRANTY_MANAGE])
    for (const key of keys) expect(key.startsWith('warranty.')).toBe(true)
    expect(warrantyManifest.coreApiVersion).toBe('^1.0.0')
    expect(warrantyManifest.category).toBe('optional')
  })

  it('declares the settings keys the server actually reads', () => {
    // `app.warranty_config` and `app.warranty_register_sale` read these names
    // out of `plugins.config`; renaming one here would silently disable it.
    const keys = (warrantyManifest.settingsSchema ?? []).map((entry) => entry.key)
    expect(keys).toEqual([
      AUTO_REGISTER_KEY,
      COVER_ALL_KEY,
      DEFAULT_MONTHS_KEY,
      WARN_DAYS_KEY,
      CLAIM_PREFIX_KEY,
    ])
    expect(DEFAULT_AUTO_REGISTER).toBe(true)
    expect(DEFAULT_COVER_ALL).toBe(false)
    expect(DEFAULT_MONTHS).toBe(12)
    expect(DEFAULT_WARN_DAYS).toBe(30)
    expect(DEFAULT_CLAIM_PREFIX).toBe('WC-')
  })
})

// ── What it registers ─────────────────────────────────────────────────────

describe('registration', () => {
  it('appears in Inventory, reachable by permission, behind one route', async () => {
    await registry.sync(['warranty'])

    const nav = registry.nav.items[0]
    expect(nav?.label).toBe('Warranty')
    expect(nav?.section).toBe('inventory')
    expect(nav?.permission).toBe(WARRANTY_VIEW)
    expect(nav?.route).toBe('/plugins/warranty')
    expect(registry.routes.items.map((route) => route.path)).toEqual(['/plugins/warranty'])
  })

  it('registers the product field the taxonomy promotes, stored in metadata', async () => {
    await registry.sync(['warranty'])

    const field = registry.productFields.items[0]
    expect(field?.key).toBe(WARRANTY_MONTHS_KEY)
    expect(field?.storage).toBe('metadata')
    // Electronics, computer, mobile and appliance shops promote exactly this
    // key (`data/shop_categories.json`), so the plugin cannot rename it.
    expect(field?.showInPOS).toBe(true)
    expect(field?.printable).toBe(true)
    expect(field?.min).toBe(0)
    expect(field?.max).toBe(600)
    const draft = { name: 'Fridge', price: null, cost_price: null, track_stock: true, metadata: {} }
    expect(field?.validate?.(null, draft)).toBeNull()
    expect(field?.validate?.(-1, draft)).not.toBeNull()
    expect(field?.validate?.(999, draft)).not.toBeNull()
    expect(field?.validate?.('junk', draft)).not.toBeNull()
    expect(field?.format?.(12)).toBe('1 year')
    expect(field?.format?.(0)).toBe('No cover')
  })

  it('puts two reports in the library, both readable by whoever can see cover', async () => {
    await registry.sync(['warranty'])

    expect(registry.reports.items.map((entry) => entry.id)).toEqual(['expiring', 'claims'])
    // The name docs/08 §5 promises the industries that ship this plugin.
    expect(registry.reports.items.map((entry) => entry.label)).toEqual([
      'Warranty expiry',
      'Warranty claims',
    ])
    for (const report of registry.reports.items) {
      expect(report.group).toBe('Service')
      expect(report.permission).toBe(WARRANTY_VIEW)
    }
    // A window of “August” means nothing to “what is running out”, and the rows
    // are counted by the server: no search box that would do nothing.
    expect(registry.reports.items[0]?.filters).toEqual({ window: true, search: false })
  })

  it('wants a dashboard tile, a till panel, a sale tab and a form section', async () => {
    await registry.sync(['warranty'])

    expect(registry.widgets.items.map((entry) => entry.id)).toEqual(['warranty.summary'])
    expect(registry.posPanels.items.map((entry) => entry.id)).toEqual(['warranty.till'])
    expect(registry.saleTabs.items.map((entry) => entry.id)).toEqual(['warranty.sale'])
    expect(registry.formSections.items.map((entry) => entry.id)).toEqual(['warranty.product'])
    expect(registry.posPanels.items[0]?.permission).toBe(WARRANTY_VIEW)
  })

  it('asks the server about one product’s promises, rather than counting a page', async () => {
    answers.list = {
      rows: [unitRow(1, { variant_name: '320L' })],
      total: 3,
      limit: 5,
      offset: 0,
      scope: 'all',
      today: '2026-09-26',
    } satisfies UnitPage
    await registry.sync(['warranty'])

    const host = await registry.formSections.items[0]!.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      productId: 'p1',
    })
    await settle()

    const asked = calls.find((call) => call.fn === 'list')
    expect(asked?.args.product_id).toBe('p1')
    expect(textOf(host)).toContain('3 promises on record')
    expect(textOf(host)).toContain('Latest: Unit 1 · Covered')
  })

  it('says where a promise comes from when a product has none yet', async () => {
    answers.list = {
      rows: [],
      total: 0,
      limit: 5,
      offset: 0,
      scope: 'all',
      today: '2026-09-26',
    } satisfies UnitPage
    await registry.sync(['warranty'])

    const fresh = await registry.formSections.items[0]!.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      productId: 'p9',
    })
    await settle()
    expect(textOf(fresh)).toContain('No promise has been written for this product yet')

    // A product that has not been saved yet has no id to ask about.
    calls = []
    const unsaved = await registry.formSections.items[0]!.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
    })
    await settle()
    expect(calls).toEqual([])
    expect(textOf(unsaved)).toContain('Set the warranty months above')
  })

  it('needs no other plugin, so it can be switched on alone', async () => {
    await registry.sync(['warranty'])
    expect(registry.get('warranty')?.status).toBe('loaded')
    expect(registry.loadedIds).toEqual(['warranty'])
  })
})

// ── What the cart is about to promise ─────────────────────────────────────

describe('the promise a cart will make', () => {
  it('reads the product first, then the shop’s own rule — never in the other order', () => {
    const rule = { coverAll: true, defaultMonths: 6 }
    const own = coveredLines(cartLine({ metadata: { [WARRANTY_MONTHS_KEY]: 24 } }), rule)
    expect(own.map((entry) => entry.months)).toEqual([24])

    const untagged = coveredLines(cartLine({ metadata: {} }), rule)
    expect(untagged.map((entry) => entry.months)).toEqual([6])
  })

  it('promises nothing when the shop covers nothing and the product says nothing', () => {
    const nothing = coveredLines(cartLine({ metadata: {} }), {
      coverAll: false,
      defaultMonths: 12,
    })
    expect(nothing).toEqual([])

    const summary = tillSummary(cartLine({ metadata: {} }), { coverAll: false, defaultMonths: 12 })
    expect(summary.label).toBe('Nothing in this cart carries cover.')
  })

  it('counts units, not lines, and says how long the cover runs', () => {
    const lines = [
      ...cartLine({ quantity: 2, metadata: { [WARRANTY_MONTHS_KEY]: 24 } }),
      ...cartLine({ productId: 'p2', metadata: { [WARRANTY_MONTHS_KEY]: 12 } }),
    ]
    const summary = tillSummary(lines, { coverAll: false, defaultMonths: 12 })
    expect(summary.lines).toBe(2)
    expect(summary.units).toBe(3)
    expect(summary.label).toBe('3 units on 2 lines · 1 year to 2 years')
  })

  it('hands the till a panel that names the lines and their cover', async () => {
    await registry.sync(['warranty'])
    const host = (await registry.posPanels.items[0]!.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      total: 5500000,
      customerId: null,
      lines: cartLine({ quantity: 2 }),
    }))!

    expect(textOf(host)).toContain('2 units on 1 line · 2 years')
    expect(textOf(host)).toContain('Fridge 320L')
    expect(textOf(host)).toContain('Written on the invoice')
  })

  it('lets the cashier untick a line, and it is covered by default', async () => {
    await registry.sync(['warranty'])
    const host = (await registry.posPanels.items[0]!.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      total: 5500000,
      customerId: null,
      lines: cartLine({ quantity: 2 }),
    }))!

    const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(boxes).toHaveLength(1)
    // Covered lines start ticked: a shop that switched Warranty on means to keep
    // its promises unless the cashier says otherwise.
    expect(boxes[0]!.checked).toBe(true)
  })

  it('draws no card at all when the cart promises nothing, or is empty', async () => {
    await registry.sync(['warranty'])
    const context = {
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      total: 0,
      customerId: null,
    }

    // An empty cart, and a cart of products with no cover, both render null —
    // the host then shows no warranty card, keeping the sale column clear.
    const bare = await registry.posPanels.items[0]!.render({ ...context, lines: [] })
    expect(bare).toBeNull()

    const untagged = await registry.posPanels.items[0]!.render({
      ...context,
      lines: cartLine({ metadata: {} }),
    })
    expect(untagged).toBeNull()
  })
})

// ── A completed sale ──────────────────────────────────────────────────────

describe('a completed sale', () => {
  it('writes the promises without anybody opening a card', async () => {
    answers.register = {
      sale_id: SALE,
      invoice_no: 'INV-2026-000042',
      created: 2,
      existing: 0,
      skipped_lines: 0,
      capped_lines: 0,
      starts_on: '2026-09-01',
      units: [unitRow(1), unitRow(2)],
    } satisfies RegisterResult
    await registry.sync(['warranty'])

    bus.emit('sale.completed', completed())
    await settle()

    expect(calls.filter((call) => call.fn === 'register')).toEqual([
      { fn: 'register', args: { sale_id: SALE } },
    ])
    expect(localStorage.getItem(`mekholi.plugin.warranty.${LAST_SALE_KEY}`)).toBe(JSON.stringify(SALE))
  })

  it('skips a line the cashier unticked, and hides its cover on the slip', async () => {
    answers.register = {
      sale_id: SALE,
      invoice_no: 'INV-2026-000042',
      created: 0,
      existing: 0,
      skipped_lines: 1,
      capped_lines: 0,
      starts_on: '2026-09-01',
      units: [],
    } satisfies RegisterResult
    await registry.sync(['warranty'])

    // The cashier opens the panel and unticks the one covered line.
    const panel = registry.posPanels.items[0]!
    const host = (await panel.render({
      organizationId: ORG,
      branchId: BRANCH,
      currency: 'BDT',
      total: 5500000,
      customerId: null,
      lines: cartLine(),
    }))!
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement
    box.checked = false
    box.dispatchEvent(new Event('change'))

    bus.emit('sale.completed', completed())
    await settle()

    // The wire call names the unticked variant, so the server (and any other
    // device) skips it.
    expect(calls.filter((call) => call.fn === 'register')).toEqual([
      { fn: 'register', args: { sale_id: SALE, skip_variants: ['v1'] } },
    ])

    // And the receipt hides that line's warranty months.
    const suppressed = panel.suppressPrintFields!()
    expect([...suppressed.get('v1')!]).toEqual([WARRANTY_MONTHS_KEY])
  })

  it('writes one sale once, however many times the event arrives', async () => {
    answers.register = { created: 1, existing: 0, units: [], skipped_lines: 0, capped_lines: 0 }
    await registry.sync(['warranty'])

    // The till's own echo and the outbox row over Realtime: two deliveries,
    // one sale (shared/bus/events.ts).
    bus.emit('sale.completed', completed())
    bus.emit('sale.completed', { ...completed(), id: 'outbox-row-9' })
    await settle()

    expect(calls.filter((call) => call.fn === 'register')).toHaveLength(1)
  })

  it('keeps a refusal instead of losing the sale, and never throws into the bus', async () => {
    refuse = 'warranty_sale_not_sold: INV-2026-000042'
    await registry.sync(['warranty'])

    bus.emit('sale.completed', completed())
    await settle()

    expect(calls.filter((call) => call.fn === 'register')).toHaveLength(1)
    // The sale stays on the work queue — which is the only reason a failure
    // here is survivable.
    expect(localStorage.getItem(`mekholi.plugin.warranty.${LAST_SALE_KEY}`)).toBeNull()
    expect(errors).toEqual([])
  })

  it('writes nothing when the shop has switched the plugin off', async () => {
    await registry.sync([])
    bus.emit('sale.completed', completed())
    await settle()

    expect(calls.filter((call) => call.fn === 'register')).toEqual([])
  })

  it('writes nothing when the shopkeeper turned automatic writing off', async () => {
    config[AUTO_REGISTER_KEY] = false
    await registry.sync(['warranty'])

    bus.emit('sale.completed', completed())
    await settle()

    expect(calls.filter((call) => call.fn === 'register')).toEqual([])
  })

  it('badges the sidebar with what it last knew, not with a round trip per render', async () => {
    await registry.sync(['warranty'])
    const badgeOf = registry.nav.items[0]!.badge!

    expect(badgeOf()).toBeNull()

    localStorage.setItem('mekholi.plugin.warranty.pending_units', JSON.stringify(3))
    expect(badgeOf()).toBe(3)
    expect(calls).toEqual([])
  })
})

// ── The sale card ─────────────────────────────────────────────────────────

describe('the sale card', () => {
  const card = (options = {}) =>
    coverCard({ db: makeDb(), settings: settingsStore(), currency: 'BDT' }, SALE, options)

  it('shows what the sale promised and what is still missing', async () => {
    answers.for_sale = coverFixture()
    const host = card()
    await settle()

    expect(textOf(host)).toContain('INV-2026-000042')
    expect(textOf(host)).toContain('1 unit still has no promise')
    expect(textOf(host)).toContain('1 unit · 1 year · 0 on record · 1 missing')
  })

  it('writes the promises when asked, and says what it wrote', async () => {
    answers.for_sale = coverFixture()
    answers.register = {
      created: 1,
      existing: 0,
      skipped_lines: 0,
      capped_lines: 0,
      units: [unitRow(1, { ends_on: '2027-09-01' })],
    } satisfies Partial<RegisterResult>
    const host = card()
    await settle()

    press(host, 'Write the promises')
    await settle()

    const registered = calls.find((call) => call.fn === 'register')
    expect(registered?.args).toEqual({ sale_id: SALE })
  })

  it('offers the plain label when the shop writes promises by hand', async () => {
    config[AUTO_REGISTER_KEY] = false
    answers.for_sale = coverFixture()
    const host = card()
    await settle()

    expect(textOf(host)).toContain('Register cover')
    expect(textOf(host)).toContain('Promises are not written automatically')
  })

  it('says a sale that is not finished has promised nothing', async () => {
    answers.for_sale = coverFixture({
      sale: {
        id: SALE,
        invoice_no: 'INV-2026-000042',
        status: 'HELD',
        sold_on: null,
        customer: null,
      },
    })
    const host = card()
    await settle()

    expect(textOf(host)).toContain('This sale is not finished')
    expect(calls.filter((call) => call.fn === 'register')).toEqual([])
  })

  it('names a unit in place, so the promise is about a thing and not a count', async () => {
    answers.for_sale = coverFixture({ units: [unitRow(1)], missing: 0 })
    const host = card()
    await settle()

    press(host, 'Name unit')
    const box = host.querySelector<HTMLInputElement>('input')!
    box.value = 'IMEI-356938035643809'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()

    const labelled = calls.find((call) => call.fn === 'label')
    expect(labelled?.args).toEqual({ warranty_id: 'w1', unit_label: 'IMEI-356938035643809' })
  })

  it('opens a claim with what was reported, in minor units', async () => {
    answers.for_sale = coverFixture({ units: [unitRow(1)], missing: 0 })
    answers.open_claim = {
      claim_id: 'c1',
      claim_no: 'WC-2026-000001',
      status: 'OPEN',
      opened_on: '2026-09-26',
      warranty_id: 'w1',
      unit_label: null,
      product_name: 'Fridge 320L',
      covered_until: '2027-09-01',
      was_expired: false,
      cost_minor: 1250,
    }
    const host = card()
    await settle()

    press(host, 'Open claim')
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop()!
    const [issue, cost] = [...dialog.querySelectorAll('input')]
    issue!.value = 'Compressor dead'
    cost!.value = '12.50'
    press(dialog, 'Open claim')
    await settle()

    const opened = calls.find((call) => call.fn === 'open_claim')
    expect(opened?.args).toEqual({
      warranty_id: 'w1',
      issue: 'Compressor dead',
      cost_minor: 1250,
    })
  })

  it('walks a claim only where the server allows it to go', async () => {
    answers.for_sale = coverFixture({
      units: [
        unitRow(1, {
          claim: {
            id: 'c1',
            claim_no: 'WC-2026-000001',
            status: 'OPEN',
            opened_on: '2026-09-10',
            closed_on: null,
            cost_minor: 900,
            issue: 'Compressor dead',
            resolution: null,
          },
        }),
      ],
      missing: 0,
    })
    const host = card()
    await settle()

    press(host, 'Work the claim')
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop()!
    const labels = [...dialog.querySelectorAll('button')].map((entry) =>
      (entry.textContent ?? '').trim()
    )
    // The ladder the server enforces, mirrored: OPEN may go straight to the
    // workshop, which is what a shop does when the fault is obvious.
    for (const step of ['Approve', 'To workshop', 'Replaced', 'Refuse', 'Finish']) {
      expect(labels).toContain(step)
    }

    press(dialog, 'Finish')
    await settle()

    const moved = calls.find((call) => call.fn === 'claim')
    expect(moved?.args).toEqual({
      claim_id: 'c1',
      status: 'CLOSED',
      resolution: '',
      cost_minor: 900,
    })
  })

  it('will not drop cover without a reason, and says why the record stays', async () => {
    answers.for_sale = coverFixture({ units: [unitRow(1)], missing: 0 })
    answers.void = { warranty_id: 'w1', voided: true, already_void: false, unit_label: null }
    const host = card()
    await settle()

    press(host, 'Drop cover')
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop()!
    // The copy says the record is kept, because a shop that dropped cover in
    // March may have to prove it in June.
    expect(textOf(dialog)).toContain('The promise is not deleted')

    press(dialog, 'Drop cover')
    await settle()
    expect(calls.filter((call) => call.fn === 'void')).toEqual([])

    dialog.querySelector<HTMLInputElement>('input')!.value = 'Refunded in full'
    press(dialog, 'Drop cover')
    await settle()

    const dropped = calls.find((call) => call.fn === 'void')
    expect(dropped?.args).toEqual({ warranty_id: 'w1', reason: 'Refunded in full' })
  })

  it('prints a certificate that carries the promise and the shop’s terms', async () => {
    const row = unitRow(1, {
      unit_label: 'IMEI-356938035643809',
      terms: 'Guaranteed by Mekholi Electronics',
      customer: 'Rahim Uddin',
    })
    const html = certificate({
      terms: row.terms,
      product: row.product_name,
      unit: row.unit_label,
      months: row.months,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      invoice_no: row.invoice_no,
      customer: row.customer,
    })

    expect(html).toContain('Warranty certificate')
    expect(html).toContain('IMEI-356938035643809')
    expect(html).toContain('2027-09-01')
    expect(html).toContain('Guaranteed by Mekholi Electronics')
    expect(html).toContain('Keep this slip')
  })

  it('escapes what a person typed, so a product name cannot end the page', () => {
    const html = certificate({
      product: '<script>alert(1)</script>',
      unit: null,
      months: 12,
      starts_on: '2026-09-01',
      ends_on: '2027-09-01',
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ── The reports ───────────────────────────────────────────────────────────

describe('the reports', () => {
  const report = (id: string) => registry.reports.items.find((entry) => entry.id === id)!

  const run = (id: string, over: Record<string, unknown> = {}) =>
    report(id).run({
      period: 'month',
      from: null,
      to: null,
      search: '',
      branchId: null,
      limit: 200,
      offset: 0,
      ...over,
    })

  it('asks for what is ending in the window, soonest first, expired included', async () => {
    answers.report = {
      type: 'expiring',
      rows: [
        unitRow(1, { days_left: -20, ends_on: '2026-09-06', unit_label: 'IMEI-1' }),
        unitRow(2),
      ],
      total: 12,
      limit: 200,
      offset: 0,
      totals: { units: 12, expired: 3, claims: 1 },
      today: '2026-09-26',
      horizon_days: 30,
      ends_to: '2026-10-26',
    } satisfies ExpiringReport
    await registry.sync(['warranty'])

    const result = await run('expiring')

    const asked = calls.find((call) => call.fn === 'report')
    expect(asked?.args.type).toBe('expiring')
    expect(asked?.args.days).toBe(30)
    expect(asked?.args.include_expired).toBe(true)

    expect(result.rows[0]?.unit).toBe('IMEI-1')
    // A unit nobody named is still a unit.
    expect(result.rows[1]?.unit).toBe('Unit 2')
    expect(result.rows[0]?.state).toBe('Expired')
    expect(result.rows[1]?.state).toBe('Covered')
    expect(result.rows[0]?.invoice).toBe('INV-2026-000042')
    expect(result.totalRows).toBe(12)
    expect(result.note).toContain('ending by 2026-10-26')
    expect(result.note).toContain('1 on this page have already ended')
    expect(result.note).toContain('3 ended in all')
  })

  it('reads a window of “this year” as a horizon, not as a period', () => {
    const year = horizonDays({ period: 'year', from: null, to: null }, 30)
    expect(year).toBe(365)
    expect(horizonDays({ period: 'week', from: null, to: null }, 30)).toBe(7)
    // A custom range is the number of days between the two dates.
    expect(horizonDays({ period: 'custom', from: '2026-09-01', to: '2026-09-11' }, 30)).toBe(10)
    expect(horizonDays({ period: 'custom', from: null, to: null }, 30)).toBe(30)
    expect(horizonDays({ period: 'custom', from: '2020-01-01', to: '2030-01-01' }, 30)).toBe(730)
    expect(windowDates({ period: 'month', from: null, to: null })).toEqual({ from: null, to: null })
    expect(windowDates({ period: 'custom', from: '2026-09-01', to: '2026-09-30' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })

  it('reports what the promises have cost, and says how many are still open', async () => {
    answers.report = {
      type: 'claims',
      rows: [
        claimRow(1, { cost_minor: 1200, status: 'CLOSED', closed_on: '2026-09-20' }),
        claimRow(2, { cost_minor: 0, status: 'OPEN' }),
      ],
      total: 9,
      limit: 200,
      offset: 0,
      totals: { claims: 9, open: 4, replaced: 1, rejected: 1, cost_minor: 550000 },
      today: '2026-09-26',
      from: '2026-08-01',
      to: '2026-08-31',
    } satisfies ClaimsReport
    await registry.sync(['warranty'])

    const result = await run('claims', {
      period: 'custom',
      from: '2026-08-01',
      to: '2026-08-31',
    })

    const asked = calls.find((call) => call.fn === 'report')
    expect(asked?.args.from).toBe('2026-08-01')
    expect(asked?.args.to).toBe('2026-08-31')

    expect(result.rows[0]?.claim_no).toBe('WC-2026-000001')
    expect(result.rows[0]?.state).toBe('compressor noisy')
    expect(result.rows[1]?.closed).toBeNull()
    expect(result.totalRows).toBe(9)
    // “What did this cost me” is a question about the period, not about page 1.
    expect(result.totals).toEqual({ cost: 550000 })
    expect(result.note).toContain('between 2026-08-01 and 2026-08-31')
    expect(result.note).toContain('4 still open')
  })

  it('reads as a report a shopkeeper would recognise', async () => {
    answers.report = {
      type: 'claims',
      rows: [claimRow(1)],
      total: 1,
      limit: 200,
      offset: 0,
      totals: { claims: 1, open: 1, replaced: 0, rejected: 0, cost_minor: 0 },
      today: '2026-09-26',
      from: '2026-07-01',
      to: '2026-09-26',
    } satisfies ClaimsReport
    await registry.sync(['warranty'])

    const result = await run('claims')
    const columnKeys = result.columns.map((column) => column.key)
    expect(columnKeys).toEqual([
      'claim_no',
      'opened',
      'closed',
      'product',
      'unit',
      'customer',
      'state',
      'days',
      'cost',
    ])
    const cost = result.columns.find((column) => column.key === 'cost')
    expect(cost?.type).toBe('money')
    expect(cost?.align).toBe('right')
    for (const key of columnKeys) expect(key in (result.rows[0] ?? {})).toBe(true)
  })
})

// ── The screen ────────────────────────────────────────────────────────────

describe('the screen', () => {
  const page = (over: Partial<UnitPage> = {}): UnitPage => ({
    rows: [unitRow(1)],
    total: 1,
    limit: 25,
    offset: 0,
    scope: 'active',
    today: '2026-09-26',
    ...over,
  })

  const queue = (over: Partial<PendingQueue> = {}): PendingQueue => ({
    rows: [
      {
        sale_id: SALE,
        invoice_no: 'INV-2026-000042',
        status: 'COMPLETED',
        sold_on: '2026-09-20',
        customer: 'Rahim Uddin',
        units_missing: 2,
        product_name: 'Fridge 320L',
        months: 12,
        lines: [],
      },
    ],
    total: 1,
    units_total: 2,
    limit: 20,
    window_days: 60,
    from: '2026-07-28',
    today: '2026-09-26',
    ...over,
  })

  const claimPage = (over: Partial<ClaimPage> = {}): ClaimPage => ({
    rows: [claimRow(1)],
    total: 1,
    limit: 25,
    offset: 0,
    status: 'OPEN',
    today: '2026-09-26',
    ...over,
  })

  async function open(): Promise<HTMLElement> {
    await registry.sync(['warranty'])
    const screen = createWarrantyScreen({ db: makeDb(), settings: settingsStore() })
    const host = await screen.render({
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

  beforeEach(() => {
    answers.overview = overviewFixture()
    answers.pending = queue()
    answers.list = page()
    answers.claims = claimPage()
  })

  it('asks its own server for everything it shows, in one pass', async () => {
    await open()

    expect(calls.map((call) => call.fn).sort()).toEqual(['claims', 'list', 'overview', 'pending'])
    const listed = calls.find((call) => call.fn === 'list')
    expect(listed?.args).toEqual({ status: 'active', search: '', limit: 25, offset: 0 })
  })

  it('shows the four numbers a shop opens it for', async () => {
    const host = await open()

    const text = textOf(host)
    expect(text).toContain('Cover in force')
    expect(text).toContain('4')
    expect(text).toContain('Running out')
    expect(text).toContain('Open claims')
    expect(text).toContain('Claims have cost')
    expect(text.replace(/\u202f/g, '')).toContain('৳2,500.00')
  })

  it('puts sales that still owe a promise first, and writes it from there', async () => {
    answers.register = { created: 2, existing: 0, units: [], skipped_lines: 0, capped_lines: 0 }
    const host = await open()

    expect(textOf(host)).toContain('Sales that still owe a promise')
    expect(textOf(host)).toContain('INV-2026-000042')
    expect(textOf(host)).toContain('2 units missing')

    press(host, 'Register cover')
    await settle()

    const registered = calls.find((call) => call.fn === 'register')
    expect(registered?.args).toEqual({ sale_id: SALE })
    // The screen re-reads after writing, so the queue cannot stay stale.
    expect(calls.filter((call) => call.fn === 'pending')).toHaveLength(2)
  })

  it('says nothing is owed when nothing is, instead of showing an empty box', async () => {
    answers.pending = queue({ rows: [], total: 0, units_total: 0 })
    const host = await open()

    expect(textOf(host)).toContain('Nothing owed')
    expect(textOf(host)).toContain('last 60 days')
  })

  it('re-reads the register when the shop changes the filter', async () => {
    const host = await open()

    const scope = host.querySelectorAll('select')[0]!
    scope.value = 'expired'
    scope.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    const listed = calls.filter((call) => call.fn === 'list').pop()
    expect(listed?.args.status).toBe('expired')
    expect(listed?.args.offset).toBe(0)
  })

  it('looks a promise up when a shopkeeper types, and browses when they do not', async () => {
    answers.lookup = page({ rows: [unitRow(1, { unit_label: 'IMEI-1' })], scope: 'lookup' })
    const host = await open()

    const box = host.querySelector<HTMLInputElement>('input[type="search"]')!
    box.value = 'IMEI-1'
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    const looked = calls.find((call) => call.fn === 'lookup')
    expect(looked?.args).toEqual({ q: 'IMEI-1' })
    expect(textOf(host)).toContain('IMEI-1')
  })

  it('reads the register itself for a one-letter search, which the server would refuse', async () => {
    const host = await open()

    const box = host.querySelector<HTMLInputElement>('input[type="search"]')!
    box.value = 'A'
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(calls.filter((call) => call.fn === 'lookup')).toEqual([])
    const listed = calls.filter((call) => call.fn === 'list').pop()
    expect(listed?.args.status).toBe('active')
  })

  it('shows the claims queue with what each one cost', async () => {
    answers.claims = claimPage({
      rows: [
        claimRow(1, { cost_minor: 1200 }),
        claimRow(2, { status: 'CLOSED', closed_on: '2026-09-20', cost_minor: 800 }),
      ],
      total: 2,
      status: 'OPEN',
    })
    const host = await open()

    const text = textOf(host)
    expect(text).toContain('Claims')
    expect(text).toContain('WC-2026-000001')
    expect(text).toContain('Reported')
    expect(text).toContain('1 on this page not finished')
  })

  it('turns a database refusal into a sentence rather than a code', async () => {
    refuse = 'permission_denied: warranty.view'
    const host = await open()

    expect(textOf(host)).toContain('your role does not allow this')
  })
})

// ── What a shopkeeper reads ───────────────────────────────────────────────

describe('what a shopkeeper reads', () => {
  it('turns a server name into a sentence, keeping the detail it was given', () => {
    expect(describeError(new Error('permission_denied: warranty.view'))).toBe(
      'your role does not allow this (warranty.view)'
    )
    expect(describeError(new Error('warranty_expired: Fridge 320L (2026-09-06)'))).toBe(
      'the cover on that unit has ended — honour it anyway if the shop chooses to (Fridge 320L (2026-09-06))'
    )
    // An unrecognised name is quoted, never invented.
    expect(describeError(new Error('postgres_thing: 42703'))).toBe('postgres_thing: 42703')
    expect(reasonLabel('warranty_claim_open')).toContain('already a claim open')
  })

  it('says how long is left in the words a person would use', () => {
    expect(daysLeftLabel(-1)).toBe('Ended yesterday')
    expect(daysLeftLabel(-41)).toBe('Ended 41 days ago')
    expect(daysLeftLabel(0)).toBe('Ends today')
    expect(daysLeftLabel(1)).toBe('Ends tomorrow')
    expect(daysLeftLabel(45)).toBe('45 days left')
    expect(daysLeftLabel(90)).toBe('3 months left')
    expect(daysLeftLabel(730)).toBe('2 years left')
    expect(monthsLabel(1)).toBe('1 month')
    expect(monthsLabel(12)).toBe('1 year')
    expect(monthsLabel(24)).toBe('2 years')
    expect(monthsLabel(3)).toBe('3 months')
    expect(monthsLabel(0)).toBe('No cover')
    expect(monthsLabel(null)).toBe('No cover')
    expect(missingCoverLabel(0)).toBe('every promised unit is on record')
    expect(unitLabel({ unit_label: '  ', unit_index: 2 })).toBe('Unit 2')
    expect(unitLabel({ unit_label: 'IMEI-1', unit_index: 2 })).toBe('IMEI-1')
  })

  it('reads a product’s own promise, and treats rubbish as none', () => {
    expect(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: 12 })).toBe(12)
    expect(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: '24' })).toBe(24)
    expect(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: '7.4' })).toBe(7)
    expect(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: 9999 })).toBe(600)
    expect(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: 0 })).toBeNull()
    expect(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: '' })).toBeNull()
    expect(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: 'forever' })).toBeNull()
    expect(monthsFromProduct(undefined)).toBeNull()
  })

  it('ends a promise on the same calendar day Postgres would', () => {
    expect(endDateFor('2026-09-01', 12)).toBe('2027-09-01')
    // A wall calendar clamps: 31 January plus one month is 28 February.
    expect(endDateFor('2026-01-31', 1)).toBe('2026-02-28')
    expect(endDateFor('2024-01-31', 1)).toBe('2024-02-29')
    expect(endDateFor('2026-09-01', 0)).toBe('2026-09-01')
    expect(endDateFor('rubbish', 12)).toBeNull()
  })

  it('derives what a promise is now, rather than storing an expiry that goes stale', () => {
    const warn = 30
    const open = unitRow(1, { days_left: 340 })
    expect(coverageLabel(coverageOf(open, warn))).toBe('Covered')
    expect(coverageLabel(coverageOf(unitRow(2, { days_left: 20 }), warn))).toBe('Expiring')
    expect(coverageLabel(coverageOf(unitRow(3, { days_left: -3 }), warn))).toBe('Expired')
    expect(coverageLabel(coverageOf(unitRow(4, { status: 'VOID' }), warn))).toBe('Void')

    // A unit in the workshop is not “covered” — that is the question the
    // customer is asking when they telephone.
    const claimed = unitRow(5, {
      claim: {
        id: 'c1',
        claim_no: 'WC-2026-000001',
        status: 'REPAIRING',
        opened_on: '2026-09-10',
        closed_on: null,
        cost_minor: 0,
        issue: null,
        resolution: null,
      },
    })
    expect(coverageLabel(coverageOf(claimed, warn))).toBe('In for repair')
    const finished = unitRow(6, {
      days_left: -3,
      claim: { ...claimed.claim!, status: 'CLOSED', closed_on: '2026-09-20' },
    })
    expect(coverageLabel(coverageOf(finished, warn))).toBe('Expired')
    expect(coverageOf(finished, warn, { hideClaims: true })).toBe('expired')
  })

  it('mirrors the claim ladder the server enforces', () => {
    // The server allows OPEN → APPROVED|REPAIRING|REPLACED|REJECTED|CLOSED,
    // APPROVED/REPAIRING to step back one, and nothing out of a finished claim.
    expect(nextClaimStatuses('OPEN')).toEqual([
      'APPROVED',
      'REPAIRING',
      'REPLACED',
      'REJECTED',
      'CLOSED',
    ])
    expect(nextClaimStatuses('APPROVED')).toEqual([
      'REPAIRING',
      'REPLACED',
      'REJECTED',
      'CLOSED',
      'OPEN',
    ])
    expect(nextClaimStatuses('REPAIRING')).toEqual(['REPLACED', 'REJECTED', 'CLOSED', 'APPROVED'])
    for (const finished of ['CLOSED', 'REJECTED', 'REPLACED']) {
      expect(nextClaimStatuses(finished)).toEqual([])
    }
    expect(claimStatusLabel('REPAIRING')).toBe('In the workshop')
    expect(claimStatusLabel('REJECTED')).toBe('Refused')
    expect(claimTone('OPEN')).toBe('warning')
    expect(claimTone('REPLACED')).toBe('success')
  })

  it('keeps money in minor units until the moment it is printed', () => {
    expect(costToMinor('12.50')).toBe(1250)
    expect(costToMinor('0')).toBe(0)
    expect(costToMinor('twelve')).toBeNull()
    // The plugin must print money exactly as the core does, thin space and all.
    expect(moneyLabel(1200, 'BDT')).toBe(formatMoney(minor(1200), { currency: 'BDT' }))
    expect(moneyLabel(550000, 'BDT')).toBe(formatMoney(minor(550000), { currency: 'BDT' }))
    expect(moneyLabel(1200, 'BDT')).toContain('12.00')
    expect(moneyLabel(550000, 'BDT')).toContain('5,500.00')
  })
})

// ── The plugin boundary (spec §51) ───────────────────────────────────────

describe('the plugin boundary', () => {
  /** Every function this plugin is allowed to call — and all it ever calls. */
  const OWN_RPCS = [
    'claim',
    'claims',
    'for_sale',
    'label',
    'list',
    'lookup',
    'open_claim',
    'overview',
    'pending',
    'register',
    'report',
    'void',
  ]

  it('calls its own functions by name and nothing else', async () => {
    // The host forwards only `public.warranty_*`; a plugin that reached for a
    // core RPC would fail on the server *and* on Android, which speaks the same
    // narrow contract. Exercising every surface and checking the vocabulary is
    // how that stays true as the plugin grows.
    answers.overview = overviewFixture()
    answers.pending = {
      rows: [],
      total: 0,
      units_total: 0,
      limit: 20,
      window_days: 60,
      from: '2026-07-28',
      today: '2026-09-26',
    } satisfies PendingQueue
    answers.list = {
      rows: [],
      total: 0,
      limit: 25,
      offset: 0,
      scope: 'active',
      today: '2026-09-26',
    } satisfies UnitPage
    answers.claims = {
      rows: [],
      total: 0,
      limit: 25,
      offset: 0,
      status: 'OPEN',
      today: '2026-09-26',
    } satisfies ClaimPage
    answers.for_sale = coverFixture()
    answers.register = { created: 1, existing: 0, units: [], skipped_lines: 0, capped_lines: 0 }
    answers.report = (args: Record<string, unknown>) =>
      args.type === 'claims'
        ? ({
            type: 'claims',
            rows: [],
            total: 0,
            limit: 200,
            offset: 0,
            totals: { claims: 0, open: 0, replaced: 0, rejected: 0, cost_minor: 0 },
            today: '2026-09-26',
            from: '2026-07-01',
            to: '2026-09-26',
          } satisfies ClaimsReport)
        : ({
            type: 'expiring',
            rows: [],
            total: 0,
            limit: 200,
            offset: 0,
            totals: { units: 0, expired: 0, claims: 0 },
            today: '2026-09-26',
            horizon_days: 30,
            ends_to: '2026-10-26',
          } satisfies ExpiringReport)

    await registry.sync(['warranty'])
    bus.emit('sale.completed', completed())
    await settle()

    const screen = createWarrantyScreen({ db: makeDb(), settings: settingsStore() })
    await screen.render({
      params: {},
      query: new URLSearchParams(),
      organizationId: ORG,
      organizationName: 'Test Shop',
      branchId: BRANCH,
      currency: 'BDT',
    })
    await settle()

    const card = coverCard({ db: makeDb(), settings: settingsStore(), currency: 'BDT' }, SALE)
    await settle()

    for (const report of registry.reports.items) {
      await report.run({
        period: 'month',
        from: null,
        to: null,
        search: '',
        branchId: null,
        limit: 50,
        offset: 0,
      })
    }

    expect(textOf(card).length).toBeGreaterThan(0)
    const called = [...new Set(calls.map((call) => call.fn))].sort()
    for (const fn of called) expect(OWN_RPCS).toContain(fn)
    // And the plugin really did exercise its vocabulary, so the check above is
    // not passing because nothing happened.
    expect(called.length).toBeGreaterThanOrEqual(6)
  })
})
