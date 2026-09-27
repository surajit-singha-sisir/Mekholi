/**
 * Money off a sale, contributed by a plugin (docs/11 §Sale adjustments).
 *
 * The till has taken a discount since migration 012 — `complete_sale` prices
 * `p_discount_type`/`p_discount_value`, the cart domain models both a line and
 * an order discount, and the receipt prints a `Discount` row — but nothing the
 * shopkeeper could press put one there. So a plugin that had *earned* a
 * customer a discount could describe it and not give it: a loyalty redemption
 * was a number on a panel.
 *
 * What these tests pin is the shape of the fix, which is the same shape as the
 * scan seam: the plugin quotes, the host decides. The plugin cannot name an
 * amount that reaches the customer's receipt, the money moves only when the
 * plugin could record it, an adjustment the cart has outgrown is withdrawn
 * with a reason, and the sale that took it tells the plugin its invoice number.
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
import type {
  Plugin,
  SaleAdjustmentContext,
  SaleAdjustmentQuote,
  SaleAdjustmentRelease,
} from '../../shared/registry/plugin-types'
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

/** ৳200.00 of rice — the sale a redemption will be taken off. */
const RICE: SellableProduct = {
  productId: 'p-rice',
  variantId: 'v-rice',
  name: 'Miniket rice',
  variantName: null,
  sku: '1234561',
  imageUrl: null,
  price: minor(20000),
  cost: 15000,
  taxRatePercent: 0,
  taxInclusive: true,
  trackStock: true,
  allowNegative: false,
  availableQty: milli(500_000),
  unitLabel: 'kg',
  decimalQuantity: false,
  categoryName: 'Rice & Grains',
  metadata: {},
}

const OIL: SellableProduct = { ...RICE, productId: 'p-oil', variantId: 'v-oil', name: 'Soybean oil', sku: '1234562', price: minor(30000) }

let barcodeHits: Record<string, SellableProduct> = {}
let completed: Array<Record<string, unknown>> = []
let quotes: SaleAdjustmentContext[] = []
let appliedCalls: Array<{ quote: SaleAdjustmentQuote; context: SaleAdjustmentContext }> = []
let released: Array<{ quote: SaleAdjustmentQuote; reason: SaleAdjustmentRelease }> = []
let settled: Array<{ quote: SaleAdjustmentQuote; saleId: string; invoiceNo: string; stored: boolean }> = []

/** What the plugin answers when asked, and what it does when told. */
let quoteReply: (context: SaleAdjustmentContext) => SaleAdjustmentQuote | null = () => ({
  amountMinor: 5000,
  label: 'Redeem 500 points',
  note: '500 points · ৳50.00 off',
  token: 'rd-1',
})
let applyFails = false
let permissions = true

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    catalog: {
      findByBarcode: async (code: string) => barcodeHits[code.trim()] ?? null,
      searchProducts: async () => ({ items: [], total: 0, limit: 40, offset: 0 }),
      listPaymentMethods: async () => [
        { id: 'pm-1', key: 'cash', name: 'Cash', isActive: true, requiresReference: false },
      ],
    },
    customers: {
      list: async () => ({
        items: [
          {
            id: 'c-1',
            name: 'Rahim Uddin',
            phone: '01700000000',
            email: null,
            address: null,
            creditLimit: 0,
            balance: 0,
            storeCredit: 0,
            note: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      }),
      create: async () => null,
    },
    sales: {
      complete: async (input: Record<string, unknown>) => {
        completed.push(input)
        return {
          sale_id: 'sale-1',
          invoice_no: 'INV-2026-000001',
          status: 'COMPLETED',
          subtotal: '200.00',
          discount: '50.00',
          tax: '0.00',
          total: '150.00',
          paid: '150.00',
          change_due: '0.00',
          queued: false,
        }
      },
      get: async () => null,
    },
  }),
}))

vi.mock('../../app/state/session', () => ({
  activeOrganization: () => ({
    organization_id: 'org-1',
    name: 'Mekholi Store',
    currency: 'BDT',
  }),
  can: () => permissions,
}))

vi.mock('../../app/state/sales-floor', async (importOriginal) => {
  const actual = await importOriginal<typeof SalesFloorModule>()
  return { ...actual, salesFloor: () => FLOOR, refreshSalesFloor: async () => undefined }
})

/** A plugin that can take money off the sale — the seam under test. */
function discountPlugin(): Plugin {
  return {
    id: 'loyalty',
    name: 'Loyalty',
    version: '1.0.0',
    register: (api) => {
      api.registerSaleAdjustment({
        id: 'loyalty.redeem',
        label: 'Loyalty',
        permission: 'loyalty.redeem',
        quote: (context) => {
          quotes.push(context)
          return quoteReply(context)
        },
        onApplied: async (quote, context) => {
          if (applyFails) throw new Error('this shop has no connection')
          appliedCalls.push({ quote, context })
        },
        onReleased: (quote, reason) => {
          released.push({ quote, reason })
        },
        onSettled: (quote, settlement) => {
          settled.push({ quote, ...settlement })
        },
      })
    },
  }
}

async function build(plugins: Plugin[] = [discountPlugin()]): Promise<HTMLElement> {
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
  await registry.sync(plugins.map((plugin) => plugin.id))

  salesFloorStore.set({ status: 'ready', floor: FLOOR })
  const view = posView({ bus, registry })
  document.body.append(view)
  return view
}

/** Scans a code the way a scanner does: one input event, then Enter. */
async function scan(view: HTMLElement, code: string): Promise<void> {
  const field = view.querySelector<HTMLInputElement>('input')!
  field.value = code
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 250))
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
}

/** Flush the macrotasks an async render takes. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const textOf = (node: Element): string => node.textContent ?? ''

function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').includes(text)
  )
  if (!found) throw new Error(`no button containing "${text}"`)
  return found
}

function buttonLabelled(root: ParentNode, label: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`no button labelled "${label}"`)
  return found
}

function hasButton(root: ParentNode, text: string): boolean {
  return [...root.querySelectorAll('button')].some((candidate) =>
    (candidate.textContent ?? '').includes(text)
  )
}

beforeEach(() => {
  barcodeHits = { '1234561': RICE }
  completed = []
  quotes = []
  appliedCalls = []
  released = []
  settled = []
  applyFails = false
  permissions = true
  quoteReply = () => ({
    amountMinor: 5000,
    label: 'Redeem 500 points',
    note: '500 points · ৳50.00 off',
    token: 'rd-1',
  })
  localStorage.clear()
  salesFloorStore.reset({ status: 'idle', floor: null, branches: [], error: null, generation: 0 })
})

afterEach(() => {
  document.body.replaceChildren()
})

/** Puts the first customer the dialog offers on the sale. */
async function attachCustomer(view: HTMLElement): Promise<void> {
  ;[...view.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('Add Customer'))!
    .click()
  await settle()
  const dialog = document.querySelector<HTMLElement>('[aria-modal="true"]')!
  ;[...dialog.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('Rahim Uddin'))!
    .click()
  await settle()
  // The list is a multi-select, so it waits for the cashier to say they are
  // finished rather than closing under the first tick.
  ;[...dialog.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').includes('Done'))!
    .click()
  await settle()
}

describe('a plugin that can take money off the sale', () => {
  it('offers its quote on the cart, and applying it takes the money off', async () => {
    const view = await build()
    await scan(view, '1234561')

    // ৳200.00 on the sale, and the plugin's offer beside it — its own words,
    // and what it costs the customer.
    expect(textOf(view)).toContain('200.00')
    expect(textOf(view)).toContain('Redeem 500 points')
    expect(textOf(view)).toContain('500 points · ৳50.00 off')
    // The quote is asked with the money in minor units, as the SDK documents.
    expect(quotes.at(-1)?.totalMinor).toBe(20000)

    buttonNamed(view, 'Apply').click()
    await settle()

    // The host put it on the sale: one order discount, shown where the cashier
    // already looks, and the total the customer will be asked for.
    expect(appliedCalls).toHaveLength(1)
    expect(appliedCalls[0]?.quote.token).toBe('rd-1')
    expect(textOf(view)).toContain('Discount')
    expect(textOf(view)).toContain('150.00')
    expect(hasButton(view, 'Remove')).toBe(true)
  })

  it('sends the discount the server stores, not a number the plugin chose', async () => {
    const view = await build()
    await scan(view, '1234561')
    buttonNamed(view, 'Apply').click()
    await settle()

    // The till will not take money for a sale with nobody on it.
    await attachCustomer(view)

    // Pay it: the dialog pre-fills the total, and Enter tenders it.
    view.querySelector<HTMLButtonElement>('[data-action=pay]')!.click()
    await settle()
    const dialog = document.querySelector<HTMLElement>('[aria-modal="true"]') ?? document.body
    const amount = dialog.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
    expect(amount).not.toBeNull()
    expect(amount?.value).toBe('150.00')
    amount?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle(12)

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ discountType: 'FLAT', discountValue: 5000 })

    // The sale tells the plugin where its money went — this is the whole reason
    // a redemption can be settled instead of guessed at.
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({
      saleId: 'sale-1',
      invoiceNo: 'INV-2026-000001',
      stored: true,
      quote: { token: 'rd-1' },
    })

    // And the next sale starts clean: no discount, nothing applied.
    expect(hasButton(view, 'Remove')).toBe(false)
    expect(textOf(view)).not.toContain('Discount')
  })

  it('gives the money back when the cashier changes their mind', async () => {
    const view = await build()
    await scan(view, '1234561')
    buttonNamed(view, 'Apply').click()
    await settle()

    buttonNamed(view, 'Remove').click()
    await settle()

    expect(released).toHaveLength(1)
    expect(released[0]?.reason).toBe('removed')
    expect(released[0]?.quote.token).toBe('rd-1')
    expect(textOf(view)).toContain('200.00')
    expect(textOf(view)).not.toContain('Discount')
    expect(hasButton(view, 'Apply')).toBe(true)
  })

  it('withdraws an adjustment the cart has outgrown, and says why', async () => {
    // The offer is the whole sale: 2000 points for everything in the cart —
    // which is what a redemption priced off the cart total looks like.
    quoteReply = (context) =>
      context.totalMinor >= 20000
        ? { amountMinor: 20000, label: 'Redeem 2000 points', token: 'rd-2000' }
        : null
    const view = await build()
    await scan(view, '1234561')
    buttonNamed(view, 'Apply').click()
    await settle()
    expect(textOf(view)).toContain('0.00')

    // The customer takes the rice away. The quote was for a sale that no longer
    // exists, and honouring it would take money off a sale it was never quoted
    // for — so it is withdrawn, and the plugin is told rather than left to work
    // it out from a total it will never see.
    buttonLabelled(view, 'Remove line').click()
    await settle()

    expect(released.some((entry) => entry.reason === 'invalid')).toBe(true)
    expect(released.at(-1)?.quote.token).toBe('rd-2000')
    expect(textOf(view)).not.toContain('Discount')
  })

  it('does not give money away when the plugin cannot record it', async () => {
    // An offline till cannot debit the customer's points. The discount is the
    // shop's money and the debit is the customer's, so neither moves.
    applyFails = true
    const view = await build()
    await scan(view, '1234561')

    buttonNamed(view, 'Apply').click()
    await settle()

    expect(applyFails).toBe(true)
    expect(textOf(view)).toContain('200.00')
    expect(textOf(view)).not.toContain('Discount')
    expect(textOf(document.body)).toContain('this shop has no connection')
    expect(hasButton(view, 'Apply')).toBe(true)
  })

  it('shows nothing at all to a cashier who may not give it', async () => {
    permissions = false
    const view = await build()
    await scan(view, '1234561')

    expect(textOf(view)).not.toContain('Redeem 500 points')
    expect(hasButton(view, 'Apply')).toBe(false)
    // The seam is still asked nothing: a permission the user lacks means the
    // plugin never runs, not that its button is hidden.
    expect(quotes).toHaveLength(0)
  })

  it('keeps a discount nobody can explain off the sale', async () => {
    const view = await build()
    await scan(view, '1234561')
    buttonNamed(view, 'Apply').click()
    await settle()
    expect(textOf(view)).toContain('150.00')

    // Hold the sale: the redemption goes back to the customer and the parked
    // cart carries no discount, so resuming it cannot give money away silently.
    buttonNamed(view, 'Hold').click()
    await settle()

    expect(released.some((entry) => entry.reason === 'cleared')).toBe(true)
    expect(textOf(view)).not.toContain('Discount')
  })

  it('matches a plugin’s offer to the sale it is standing on', async () => {
    // The plugin prices its offer off the sale, and the sale is the sale *it*
    // was asked about: the host asks again whenever the cart changes, and asks
    // with the customer attached, because a redemption that does not know who
    // is paying is not a redemption at all.
    const view = await build()
    await scan(view, '1234561')
    expect(quotes.at(-1)?.customerId).toBeNull()
    expect(quotes.at(-1)?.totalMinor).toBe(20000)

    buttonLabelled(view, 'Add a customer to this sale').click()
    await settle()
    const search = document.querySelector<HTMLInputElement>('[aria-modal="true"] input')
    expect(search).not.toBeNull()
    if (search) {
      search.value = 'Rahim'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    await settle()

    expect(textOf(view)).toContain('Rahim Uddin')
    expect(quotes.at(-1)?.customerId).toBe('c-1')
  })

  it('refuses to treat a made-up number as a discount', async () => {
    // A quote that is not a whole number of minor units, or not positive, is
    // not money off: the host contains it the way it contains a scan.
    quoteReply = () => ({ amountMinor: 1250.5, label: 'Redeem 1 point' })
    const view = await build()
    await scan(view, '1234561')

    expect(hasButton(view, 'Apply')).toBe(false)
    expect(textOf(view)).not.toContain('Discount')

    quoteReply = () => ({ amountMinor: -5000, label: 'Nice try' })
    await scan(view, '1234561')
    expect(textOf(view)).not.toContain('Nice try')
  })
})

// ── What the sale can pay for ─────────────────────────────────────────────

describe('money the sale cannot pay for', () => {
  /** A second plugin offering money off, so two offers can be added up. */
  function couponPlugin(amountMinor: number): Plugin {
    return {
      id: 'coupons',
      name: 'Coupons',
      version: '1.0.0',
      register: (api) => {
        api.registerSaleAdjustment({
          id: 'coupons.taka-off',
          label: 'Coupons',
          quote: () => ({ amountMinor, label: 'Coupon: 120 off', token: 'cp-1' }),
          onReleased: (quote, reason) => {
            released.push({ quote, reason })
          },
        })
      },
    }
  }

  it('never draws an Apply the sale could not pay', async () => {
    // 500.00 off a 200.00 sale. `complete_sale` clamps an order discount to the
    // sale, so pressing it would hand the customer 200.00 for 5,000 points and
    // debit the rest against nothing.
    quoteReply = () => ({ amountMinor: 50000, label: 'Redeem 5000 points', token: 'rd-big' })
    const view = await build()
    await scan(view, '1234561')

    expect(hasButton(view, 'Apply')).toBe(false)
    expect(textOf(view)).not.toContain('Redeem 5000 points')
    expect(textOf(view)).toContain('200.00')
  })

  it('offers a second adjustment only while the sale can still pay for both', async () => {
    // Two plugins, 120.00 off each, on the same 200.00 sale. Either is fine;
    // both is 240.00, which the sale cannot pay — and the host is the only party
    // that can see both at once.
    quoteReply = () => ({ amountMinor: 12000, label: 'Redeem 1200 points', token: 'rd-a' })
    const view = await build([discountPlugin(), couponPlugin(12000)])
    await scan(view, '1234561')
    expect(hasButton(view, 'Apply')).toBe(true)

    buttonNamed(view, 'Apply').click()
    await settle()

    // The coupon's offer is gone — the sale cannot pay for it any more.
    expect(textOf(view)).not.toContain('Coupon: 120 off')
    expect(textOf(view)).toContain('80.00')
  })

  it('withdraws what the sale has shrunk out from under, both of them', async () => {
    // Both applied on a 500.00 cart, then the dear line comes off: 240.00 of
    // adjustments on a 200.00 sale, which the host must withdraw — a plugin
    // that had already debited points would otherwise have taken them for a
    // discount the customer never received.
    barcodeHits = { '1234561': RICE, '1234562': OIL }
    quoteReply = () => ({ amountMinor: 12000, label: 'Redeem 1200 points', token: 'rd-a' })
    const view = await build([discountPlugin(), couponPlugin(12000)])
    await scan(view, '1234561')
    await scan(view, '1234562')
    await settle()

    const applies = [...view.querySelectorAll('button')].filter((entry) =>
      (entry.textContent ?? '').includes('Apply')
    )
    expect(applies).toHaveLength(2)
    applies[0]?.click()
    await settle()
    applies[1]?.click()
    await settle()

    const lines = [...view.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove line"]')]
    expect(lines).toHaveLength(2)
    lines[1]?.click()
    await settle()

    // The dear line is gone, so the cart is 200.00 against 240.00 of promises.
    expect(textOf(view)).toContain('200.00')
    expect(released.filter((entry) => entry.reason === 'invalid')).toHaveLength(2)
    expect(textOf(view)).not.toContain('Discount')
  })
})
