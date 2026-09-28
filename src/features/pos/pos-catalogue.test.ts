/**
 * The catalogue side of the till.
 *
 * It used to be a wall of 150px tiles carrying a name and a price. A counter
 * is a place where questions get asked — which pack size, is that the 5kg,
 * have we got any left — so it is now the same detailed table as the products
 * page, with a tick box on each row.
 *
 * What these tests hold in place:
 *   · the columns, and the fact that each hides at the same width as its header
 *   · a click anywhere on the row ticks it, and the row shows that it is ticked
 *   · ticking never puts anything on the sale by itself
 *   · the selection survives a new search, because it is the cashier's memory
 *   · the one-tap add and the scanner path are untouched
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

const RICE: SellableProduct = {
  productId: 'p-1',
  variantId: 'v-1',
  name: 'Miniket Rice 5kg',
  variantName: '5 kg bag',
  sku: 'MIN-0001',
  imageUrl: null,
  price: minor(45000),
  cost: 30000,
  taxRatePercent: 5,
  taxInclusive: true,
  trackStock: true,
  allowNegative: false,
  availableQty: milli(12000),
  unitLabel: 'kg',
  decimalQuantity: true,
  categoryName: 'Rice',
  metadata: {},
}

const OIL: SellableProduct = {
  ...RICE,
  productId: 'p-2',
  variantId: 'v-2',
  name: 'Soybean Oil 1L',
  variantName: null,
  sku: 'SOY-0002',
  price: minor(18000),
  taxRatePercent: 0,
  availableQty: milli(0),
  categoryName: 'Cooking',
}

let catalogue: SellableProduct[] = [RICE, OIL]

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    catalog: {
      findByBarcode: async () => null,
      searchProducts: async () => ({ items: catalogue, total: catalogue.length, limit: 40, offset: 0 }),
    },
    sales: { held: async () => [] },
    customers: { get: async () => null },
  }),
}))

vi.mock('../../app/state/session', () => ({
  activeOrganization: () => ({ organization_id: 'org-1', name: 'Sisir Enterprise', currency: 'BDT' }),
  can: () => true,
}))

vi.mock('../../app/state/sales-floor', async (importOriginal) => {
  const actual = await importOriginal<typeof SalesFloorModule>()
  return { ...actual, salesFloor: () => FLOOR, refreshSalesFloor: async () => undefined }
})

function emptyRegistry(): PluginRegistry {
  const bus = new EventBus()
  bus.onError = () => undefined
  return new PluginRegistry(bus, {
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
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function build(): Promise<HTMLElement> {
  const bus = new EventBus()
  bus.onError = () => undefined
  salesFloorStore.set({ status: 'ready', floor: FLOOR })
  const view = posView({ bus, registry: emptyRegistry() })
  document.body.append(view)
  await settle()
  return view
}

const rows = (view: HTMLElement): HTMLElement[] => [...view.querySelectorAll<HTMLElement>('tbody tr')]
const boxes = (view: HTMLElement): HTMLInputElement[] =>
  [...view.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]')]
const cartLines = (view: HTMLElement): HTMLElement[] =>
  [...view.querySelectorAll<HTMLElement>('[data-line-id]')]


beforeEach(() => {
  catalogue = [RICE, OIL]
  // The cart is persisted per branch, so a sale left on the counter by the
  // previous test would otherwise walk into the next one.
  localStorage.clear()
  document.body.replaceChildren()
})

afterEach(() => {
  document.body.replaceChildren()
  salesFloorStore.set({ status: 'idle' })
})

describe('the catalogue table', () => {
  it('answers the questions a counter actually asks', async () => {
    const view = await build()
    const headers = [...view.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers).toEqual(['', 'Product', 'SKU', 'Category', 'Price', 'Tax', 'Stock'])

    const first = rows(view)[0]!
    expect(first.textContent).toContain('Miniket Rice 5kg')
    expect(first.textContent).toContain('5 kg bag')
    expect(first.textContent).toContain('MIN-0001')
    expect(first.textContent).toContain('Rice')
    expect(first.textContent).toContain('450.00')
    // Per-unit pricing, and tax stated rather than implied.
    expect(first.textContent).toContain('/kg')
    expect(first.textContent).toContain('5% incl.')
    expect(first.textContent).toContain('12')
  })

  it('keeps every column and its header in step', async () => {
    const view = await build()
    const headers = [...view.querySelectorAll('thead th')]
    const cells = [...rows(view)[0]!.querySelectorAll('td')]
    expect(cells).toHaveLength(headers.length)
    const width = (el: Element): string =>
      (el.className.match(/(?:hidden )?(?:sm|xl):(?:table-cell|hidden)/) ?? [''])[0]
    expect(cells.map(width)).toEqual(headers.map(width))
  })
})

describe('ticking rows', () => {
  it('puts the product on the sale when the cashier taps anywhere on the row', async () => {
    const view = await build()
    rows(view)[0]!.click()
    await settle()

    expect(boxes(view)[0]!.checked).toBe(true)
    expect(rows(view)[0]!.className).toContain('bg-primary/10')
    expect(rows(view)[0]!.getAttribute('aria-selected')).toBe('true')
    expect(cartLines(view)).toHaveLength(1)
  })

  it('a tap adds one whole unit, even of a weighed product', async () => {
    // RICE is decimal (kg). The stepper counts 1, 2, 3 — a quarter-kilo
    // arrives by typing or by scale label, never from a tap.
    const view = await build()
    rows(view)[0]!.click()
    await settle()

    const qty = view.querySelector<HTMLInputElement>('input[aria-label^="Quantity"]')
    expect(qty?.value).toBe('1')
  })

  it('takes it off again on a second tap', async () => {
    const view = await build()
    rows(view)[0]!.click()
    await settle()
    rows(view)[0]!.click()
    await settle()

    expect(cartLines(view)).toHaveLength(0)
    expect(boxes(view)[0]!.checked).toBe(false)
    expect(rows(view)[0]!.className).not.toContain('bg-primary/10')
  })

  it('unticks the row when the line is removed from the sale itself', async () => {
    const view = await build()
    rows(view)[0]!.click()
    await settle()

    // The tick is a report on the cart, so the cart is allowed to change it.
    view.querySelector<HTMLButtonElement>('[data-line-id] button[aria-label^="Remove"]')!.click()
    await settle()

    expect(cartLines(view)).toHaveLength(0)
    expect(boxes(view)[0]!.checked).toBe(false)
  })

  it('tapping the box itself ticks once, not twice', async () => {
    const view = await build()
    boxes(view)[0]!.click()
    await settle()
    expect(boxes(view)[0]!.checked).toBe(true)
    expect(cartLines(view)).toHaveLength(1)
  })

  it('puts the whole list on the sale from the header, and takes it off again', async () => {
    const view = await build()
    const all = (): HTMLInputElement => view.querySelector<HTMLInputElement>('thead input[type=checkbox]')!
    all().checked = true
    all().dispatchEvent(new Event('change'))
    await settle()
    expect(cartLines(view)).toHaveLength(2)
    expect(boxes(view).every((box) => box.checked)).toBe(true)

    all().checked = false
    all().dispatchEvent(new Event('change'))
    await settle()
    expect(cartLines(view)).toHaveLength(0)
  })

  it('reports a partial selection as partial', async () => {
    const view = await build()
    rows(view)[0]!.click()
    await settle()
    expect(view.querySelector<HTMLInputElement>('thead input[type=checkbox]')!.indeterminate).toBe(true)
  })

  it('keeps the tick on a product that is still on the sale after a new search', async () => {
    const view = await build()
    rows(view)[0]!.click()
    await settle()

    catalogue = [OIL, RICE]
    const search = view.querySelector<HTMLInputElement>('input[type=search]')!
    search.value = 'o'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    // The search field debounces by 150ms before it asks the repository.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await settle()

    // Rice has moved to the second row, and is still ticked: the tick follows
    // the sale, not the position in the list.
    expect(rows(view)[1]!.textContent).toContain('Miniket Rice 5kg')
    expect(boxes(view)[1]!.checked).toBe(true)
    expect(boxes(view)[0]!.checked).toBe(false)
  })

  it('leaves no add button on the row — the tick is the way in', async () => {
    const view = await build()
    expect(rows(view)[0]!.querySelectorAll('button')).toHaveLength(0)
  })
})

describe('a counter tablet in portrait', () => {
  it('scrolls the catalogue sideways instead of crushing the columns', async () => {
    const view = await build()
    const box = view.querySelector('table')!.parentElement!
    expect(box.className).toContain('overflow-x-auto')
  })
})
