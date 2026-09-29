/**
 * Stock overview test.
 *
 * What matters on this screen is that the summary reports the database's
 * numbers unchanged, that the low/out tabs actually filter, and that the
 * actions offered match what the role may do. It is the first screen a
 * shopkeeper opens when something is missing from a shelf, so a wrong or
 * missing figure sends them looking in the wrong place.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stockView } from './stock-view'
import { milli, minor } from '../../shared/domain/money'

const row = (over: Record<string, unknown> = {}) => ({
  variantId: 'v-1',
  productId: 'p-1',
  productName: 'Basmati Rice 5kg',
  variantName: null,
  sku: 'RICE-5',
  warehouseId: 'w-1',
  warehouseName: 'Shop Floor',
  quantity: milli(17_000),
  avgUnitCost: minor(15_000),
  stockValue: minor(2_550_000),
  reorderPoint: milli(5_000),
  trackStock: true,
  isLow: false,
  isOut: false,
  updatedAt: '2026-09-25T10:00:00.000Z',
  ...over,
})

const listMock = vi.fn(async () => ({ items: [row(), row({ variantId: 'v-2', productName: 'Mustard Oil 1L', quantity: milli(2_000), isLow: true, stockValue: minor(60_000) })], nextCursor: null }))
const summaryMock = vi.fn(async () => ({
  stockValue: minor(2_610_000),
  variantsInStock: 2,
  lowStock: 1,
  outOfStock: 0,
  warehouses: 1,
  movementsToday: 4,
}))

let permissions: string[] = ['inventory.view', 'inventory.stock_in', 'inventory.stock_out', 'inventory.transfer']

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    stock: {
      list: listMock,
      summary: summaryMock,
      listWarehouses: vi.fn(async () => [{ id: 'w-1', name: 'Shop Floor', isRetailFloor: true }]),
      history: vi.fn(),
    },
  }),
}))

vi.mock('../../app/state/session', () => ({
  activeOrganization: () => ({ currency: 'BDT' }),
  can: (key: string) => permissions.includes(key),
}))

vi.mock('../../app/state/stock-alerts', () => ({
  refreshStockAlerts: vi.fn(async () => undefined),
  stockAlertStore: {
    state: { lowStock: 0, outOfStock: 0, error: null, loaded: true },
    subscribe: () => () => undefined,
  },
  lowStockCount: () => 0,
}))

vi.mock('../../app/state/sales-floor', () => ({
  salesFloor: () => ({ warehouseId: 'w-1' }),
  refreshSalesFloor: vi.fn(async () => null),
  salesFloorStore: { state: { status: 'ready', floor: null, error: null, generation: 1 }, subscribe: () => () => undefined },
}))

beforeEach(() => {
  permissions = ['inventory.view', 'inventory.stock_in', 'inventory.stock_out', 'inventory.transfer']
  listMock.mockClear()
  summaryMock.mockClear()
  document.body.replaceChildren()
})

afterEach(() => {
  document.body.replaceChildren()
})

async function render(): Promise<HTMLElement> {
  const view = stockView({ onNavigate: () => undefined })
  document.body.appendChild(view)
  await vi.waitFor(() => {
    expect(view.textContent).toContain('Basmati Rice')
  })
  return view
}

describe('stock overview', () => {
  it('reports the summary the database returned, unrounded', async () => {
    const view = await render()
    // `formatMoney` separates the symbol from the amount with a non-breaking
    // space, which is right for a screen and invisible in a diff — so compare
    // on a normalised string rather than the raw text.
    const text = (view.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ')
    expect(text).toContain('৳ 26,100.00') // 2_610_000 minor
    expect(text).toContain('Stock value')
    await vi.waitFor(() => expect(text).toContain('Low stock'))
  })

  it('flags low stock on the row, not just in the summary', async () => {
    const view = await render()
    expect(view.textContent).toContain('Low')
    expect(view.textContent).toContain('Mustard Oil 1L')
  })

  it('offers only the operations the role may perform', async () => {
    permissions = ['inventory.view']
    const view = await render()
    const labels = [...view.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).not.toContain('Stock in')
    expect(labels).not.toContain('Stock out')
    expect(labels).not.toContain('Transfer')
  })

  it('the Low tab asks the repository for the filtered set', async () => {
    const view = await render()
    const lowTab = [...view.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Low')
    expect(lowTab).toBeTruthy()
    listMock.mockClear()
    lowTab?.click()
    await vi.waitFor(() => expect(listMock).toHaveBeenCalled())
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ filter: 'low' }))
  })

  it('locks the transfer source to the current branch', async () => {
    const view = await render()
    // The button carries an icon ligature ("swap_horiz") before its label, so
    // match on a substring rather than the exact text.
    const transferBtn = [...view.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Transfer')
    ) as HTMLButtonElement | undefined
    expect(transferBtn).toBeTruthy()
    transferBtn?.click()

    const from = await vi.waitFor(() => {
      const el = document.getElementById('stock-warehouse-from') as HTMLSelectElement | null
      expect(el).toBeTruthy()
      return el as HTMLSelectElement
    })
    // The source cannot be changed — stock only ever leaves this branch — and
    // it is pinned to the branch's own location.
    expect(from.disabled).toBe(true)
    expect(from.value).toBe('w-1')
  })

  it('opens the ledger for the row that was tapped', async () => {
    const navigate = vi.fn()
    const view = stockView({ onNavigate: navigate })
    document.body.appendChild(view)
    await vi.waitFor(() => expect(view.textContent).toContain('Basmati Rice'))

    // The universal table makes the whole row the way into the ledger.
    const row = [...view.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('Basmati Rice')) as HTMLElement
    row.click()
    expect(navigate).toHaveBeenCalledWith('/stock/history/v-1')
  })
})
