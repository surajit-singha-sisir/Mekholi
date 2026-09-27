/**
 * The invoice, after the sale.
 *
 * A receipt printed at the till is the one the customer walks out with. Every
 * other request for it arrives later — "email me the PDF", "the paper jammed",
 * "the accountant wants it" — and until now Sales history could show a sale
 * but not produce its invoice. These four actions close that gap.
 *
 * What the tests pin is the part that is easy to get wrong later: the invoice
 * is built from the *stored* sale through the same `buildReceipt` the till
 * uses, and the sale is fetched once however many of the four are pressed.
 * A reprint that quietly re-rendered today's prices would be worse than no
 * reprint at all.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { salesView } from './sales-view'
import { EventBus } from '../../shared/bus'
import { PluginRegistry } from '../../shared/registry/plugin-registry'
import { milli, minor } from '../../shared/domain/money'
import type { SaleDetail, SalesListRow } from '../../shared/repositories/contracts'
import type { SaleRow } from '../../shared/types/records'

const LIST_ROW: SalesListRow = {
  id: 's-1',
  invoiceNo: 'INV-0007',
  status: 'COMPLETED',
  customerId: null,
  customerName: null,
  branchName: 'Main Store',
  total: minor(45000),
  paidTotal: minor(45000),
  createdAt: '2026-09-20T09:00:00Z',
  completedAt: '2026-09-20T09:00:00Z',
}

const DETAIL: SaleDetail = {
  sale: LIST_ROW,
  items: [
    {
      id: 'si-1',
      productName: 'Kala Jam',
      variantName: null,
      quantity: milli(1000),
      returnedQty: milli(0),
      unitPrice: minor(45000),
      lineTotal: minor(45000),
    },
  ],
  payments: [{ id: 'p-1', methodName: 'Cash', amount: minor(45000), receivedAt: '2026-09-20T09:00:00Z' }],
  returns: [],
}

/** What `sales.get` answers with — PostgREST shapes, money as strings. */
const SALE_ROW = {
  id: 's-1',
  invoice_no: 'INV-0007',
  status: 'COMPLETED',
  currency: 'BDT',
  subtotal: '450.00',
  discount_total: '0.00',
  tax_total: '0.00',
  total: '450.00',
  paid_total: '450.00',
  change_due: '0.00',
  note: null,
  created_at: '2026-09-20T09:00:00Z',
  completed_at: '2026-09-20T09:00:00Z',
  created_by: 'Sisir',
  customer: null,
  items: [
    {
      variant_id: 'v-1',
      product_name: 'Kala Jam',
      variant_name: null,
      quantity: '1',
      unit_label: 'pc',
      unit_price: '450.00',
      line_total: '450.00',
    },
  ],
} as unknown as SaleRow

const getSale = vi.fn(async () => SALE_ROW)

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    sales: {
      listAll: async () => ({ items: [LIST_ROW], total: 1, limit: 20, offset: 0 }),
      detail: async () => DETAIL,
      get: getSale,
    },
    catalog: { listPaymentMethods: async () => [] },
  }),
}))

vi.mock('../../app/state/session', () => ({
  activeOrganization: () => ({ organization_id: 'org-1', name: 'Sisir Enterprise', currency: 'BDT' }),
  can: () => true,
}))

vi.mock('../../app/state/sales-floor', () => ({ salesFloor: () => null }))

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

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

const named = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    (button.querySelector('[data-label]')?.textContent ?? button.textContent ?? '').trim() === label
  )

/** Opens the first sale in the list, which is where the invoice lives. */
async function openSale(): Promise<HTMLElement> {
  const view = salesView({ registry: emptyRegistry() })
  document.body.append(view)
  await settle()

  const row = [...view.querySelectorAll<HTMLElement>('tr, [role="row"], button')].find((element) =>
    (element.textContent ?? '').includes('INV-0007')
  )
  row?.click()
  await settle()
  return view
}

beforeEach(() => {
  getSale.mockClear()
  localStorage.clear()
  document.body.replaceChildren()
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('an invoice, months after the sale', () => {
  it('keeps the branch name off the rows while the Branch plugin is off', async () => {
    const view = salesView({ registry: emptyRegistry() })
    document.body.append(view)
    await settle()
    // The fixture sale belongs to "Main Store"; a one-branch shop must not
    // read a branch label on every line of its history.
    expect(view.textContent).toContain('INV-0007')
    expect(view.textContent).not.toContain('Main Store')
  })

  it('offers all four ways to hand it over', async () => {
    await openSale()

    expect(named('Preview invoice')).toBeDefined()
    expect(named('Print')).toBeDefined()
    expect(named('Image')).toBeDefined()
    expect(named('PDF')).toBeDefined()
  })

  it('previews the stored sale, not a re-rendering of the screen', async () => {
    await openSale()
    named('Preview invoice')!.click()
    await settle()

    // The receipt dialog, carrying the numbers Postgres stored.
    const receipt = document.querySelector('#mekholi-print-root')
    expect(receipt).not.toBeNull()
    expect(receipt!.textContent).toContain('INV-0007')
    expect(receipt!.textContent).toContain('Kala Jam')
    expect(receipt!.textContent).toContain('450.00')
    // Built from `sales.get`, which is the row the sale was written as.
    expect(getSale).toHaveBeenCalledWith('s-1')
  })

  it('fetches the sale once however many actions are pressed', async () => {
    await openSale()

    named('Preview invoice')!.click()
    await settle()
    named('Preview invoice')!.click()
    await settle()

    expect(getSale).toHaveBeenCalledTimes(1)
  })
})
