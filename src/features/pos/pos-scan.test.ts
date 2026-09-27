/**
 * The till resolving a scan it does not recognise (docs/11 §Scan resolvers).
 *
 * A shop's weighing machine prints a label with a code in it — `2212340007504`
 * — and that code is not, and never will be, a row in the shop's barcode table.
 * Before this seam existed, scanning one searched the catalogue for the number
 * and found nothing, so a grocery could not sell 1.250 kg of lentils at all.
 *
 * What these tests pin is the *shape* of the fix: the plugin decodes and nothing
 * else, the core looks the result up in the same barcode table, and the line
 * that lands in the cart carries the weight and the price the label carried.
 * A plugin can therefore never ring up a product the shop does not sell.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { posView } from './pos-view'
import { salesFloorStore } from '../../app/state/sales-floor'
import type * as SalesFloorModule from '../../app/state/sales-floor'
import { EventBus } from '../../shared/bus'
import { PluginRegistry } from '../../shared/registry/plugin-registry'
import { milli, minor } from '../../shared/domain/money'
import type { Plugin, ScanContext } from '../../shared/registry/plugin-types'
import type { SellableProduct } from '../../shared/repositories/contracts'

const FLOOR = {
  branchId: 'b-1',
  branchName: 'Main Store',
  warehouseId: 'w-1',
  warehouseName: 'Shop Floor',
  registerId: 'r-1',
  registerName: 'Counter 1',
  sessionId: null,
}

/** The one product the scale's PLU points at: rice, sold by the kilogram. */
const RICE: SellableProduct = {
  productId: 'p-rice',
  variantId: 'v-rice',
  name: 'Miniket rice',
  variantName: null,
  sku: '12340',
  imageUrl: null,
  price: minor(9500),
  cost: 7000,
  taxRatePercent: 0,
  taxInclusive: true,
  trackStock: true,
  allowNegative: false,
  availableQty: milli(200_000),
  unitLabel: 'kg',
  decimalQuantity: true,
  categoryName: 'Rice & Grains',
  metadata: {},
}

let barcodeHits: Record<string, SellableProduct> = {}
let searched: string[] = []
let asked: Array<{ code: string; context: ScanContext }> = []
let resolveImpl: (code: string) => unknown = () => null

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    catalog: {
      findByBarcode: async (code: string) => barcodeHits[code.trim()] ?? null,
      searchProducts: async (query: { search?: string }) => {
        searched.push(query.search ?? '')
        return { items: [], total: 0, limit: 40, offset: 0 }
      },
    },
  }),
}))

vi.mock('../../app/state/session', () => ({
  activeOrganization: () => ({
    organization_id: 'org-1',
    name: 'Mekholi Store',
    currency: 'BDT',
  }),
  can: () => true,
}))

vi.mock('../../app/state/sales-floor', async (importOriginal) => {
  const actual = await importOriginal<typeof SalesFloorModule>()
  return { ...actual, salesFloor: () => FLOOR, refreshSalesFloor: async () => undefined }
})

/** A plugin that reads the shop's scale labels: `22` + PLU + value + check. */
function scalePlugin(): Plugin {
  return {
    id: 'weight-scale',
    name: 'Weighing scale',
    version: '1.0.0',
    register: (api) => {
      api.registerScanResolver({
        id: 'weight-scale.scan',
        label: 'Weighing scale',
        resolve: (code, context) => {
          asked.push({ code, context })
          return resolveImpl(code) as never
        },
      })
    },
  }
}

async function build(plugins: Plugin[] = [scalePlugin()]): Promise<HTMLElement> {
  const bus = new EventBus()
  bus.onError = () => undefined
  const registry = new PluginRegistry(bus, {
    settings: () => ({
      get: <T,>(_key: string, fallback: T): T => fallback,
      all: () => ({}),
      set: async () => undefined,
    }),
    data: () => ({
      get: async <T,>(_key: string, fallback: T): Promise<T> => fallback,
      set: async () => undefined,
      remove: async () => false,
      keys: async () => [],
    }),
    db: () => ({ products: async () => [], rpc: async <T,>(): Promise<T> => null as T }),
  })
  for (const plugin of plugins) {
    registry.declare({
      manifest: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        coreApiVersion: '^1.0.0',
        description: '',
        category: 'optional',
      },
      load: async () => plugin,
    })
  }
  // The app awaits this at boot; a till must never race its own plugins.
  await registry.sync(plugins.map((plugin) => plugin.id))

  salesFloorStore.set({ status: 'ready', floor: FLOOR })
  const view = posView({ bus, registry })
  document.body.append(view)
  return view
}

/**
 * Scans a code the way a scanner does: the characters arrive as one `input`
 * event (which the till debounces by 150 ms) and then Enter.
 */
async function scan(view: HTMLElement, code: string): Promise<void> {
  const field = view.querySelector<HTMLInputElement>('input')!
  field.value = code
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 250))
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const textOf = (node: Element): string => node.textContent ?? ''

/** The quantities the cart is actually holding — they live in inputs. */
const quantities = (view: HTMLElement): string[] =>
  [...view.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value)

beforeEach(() => {
  barcodeHits = {}
  searched = []
  asked = []
  resolveImpl = () => null
  localStorage.clear()
  salesFloorStore.reset({ status: 'idle', floor: null, branches: [], error: null, generation: 0 })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('a scan the barcode table does not know', () => {
  it('asks the plugins, and the plugin’s code is looked up in the same barcode table', async () => {
    // The shop entered its scale's PLU as the product's own code — one setup
    // step, and the only place a code can become a sellable thing.
    barcodeHits['12340'] = RICE
    resolveImpl = () => ({ lookupCode: '12340', quantity: 2.35, note: 'Scale label · 2.350 kg' })
    const view = await build()

    await scan(view, '2212340007504')

    expect(asked).toHaveLength(1)
    expect(asked[0]?.code).toBe('2212340007504')
    expect(asked[0]?.context).toMatchObject({ warehouseId: 'w-1', currency: 'BDT' })

    // The line is in the cart, at the weight on the label, priced by the shop.
    const text = textOf(view)
    expect(text).toContain('Miniket rice')
    // The cashier is told what the label said, in the shop's own words.
    expect(textOf(document.body)).toContain('Scale label · 2.350 kg')
    // The line starts at the weight on the label — not at the till's own
    // 0.250 kg step, which is what a bare product tap would have added.
    expect(quantities(view)).toContain('2.35')
    // 2.35 kg × ৳95.00 — priced by the catalogue, multiplied by the till.
    expect(text).toContain('223.25')
    // A recognised scan is not a search: the code never reaches the catalogue.
    expect(searched).not.toContain('2212340007504')
  })

  it('warns when the label’s price is not the shop’s, and charges the shop’s', async () => {
    barcodeHits['12341'] = { ...RICE, sku: '12341' }
    // A price-embedded label, printed before the shelf price moved: it says
    // ৳90.00 a kilo, and the shop charges ৳95.00 today.
    resolveImpl = () => ({ lookupCode: '12341', quantity: 1.5, unitPriceMinor: 9000 })
    const view = await build()

    await scan(view, '2212341014250')

    expect(quantities(view)).toContain('1.5')
    // 1.5 × ৳95.00 — the shop's price, because `complete_sale` prices the
    // receipt from the catalogue and the screen must not promise otherwise.
    expect(textOf(view)).toContain('142.50')
    // …and the cashier is told, in both numbers, that the shelf moved.
    const warned = textOf(document.body)
    expect(warned).toContain('90.00')
    expect(warned).toContain('95.00')
    expect(warned).toContain('Charging the shop’s price')
  })

  it('ignores a price a plugin made up', async () => {
    barcodeHits['12341'] = { ...RICE, sku: '12341' }
    resolveImpl = () => ({ lookupCode: '12341', quantity: 1, unitPriceMinor: -50000 })
    const view = await build()

    await scan(view, '2212341014250')

    // A negative price is not a price: the host dropped it before the cart saw
    // it, so there is nothing to warn about and the catalogue's ৳95.00 stands.
    expect(textOf(view)).toContain('95.00')
    expect(textOf(document.body)).not.toContain('Charging the shop’s price')
  })

  it('says what the plugin understood when the shop cannot sell that code', async () => {
    resolveImpl = () => ({ lookupCode: '12340', quantity: 2.35 })
    const view = await build()

    await scan(view, '2212340007504')

    // Not “no products match”: the shopkeeper needs to know the scale and the
    // catalogue disagree, and which code to go and fix.
    expect(textOf(view)).toContain('Weighing scale read that as 12340')
    expect(textOf(view)).toContain('no product in this shop carries that code')
    expect(searched).not.toContain('2212340007504')
  })

  it('leaves a code no plugin claims to the ordinary search', async () => {
    resolveImpl = () => null
    const view = await build()

    await scan(view, '5012345678900')

    expect(asked).toHaveLength(1)
    expect(searched).toContain('5012345678900')
  })

  it('never asks a plugin about a code the shop’s own barcodes know', async () => {
    barcodeHits['5012345678900'] = RICE
    resolveImpl = () => ({ lookupCode: '12340', quantity: 9 })
    const view = await build()

    await scan(view, '5012345678900')

    // A real barcode is authoritative: an add-on must not be able to shadow it.
    expect(asked).toEqual([])
    expect(searched).not.toContain('5012345678900')
    expect(textOf(view)).toContain('Miniket rice')
  })
})
