/**
 * The offline layer, tested where it can be tested without a browser.
 *
 * Two halves, and only one of them is a unit test:
 *
 *   The *queue's* promises are behavioural, so they are asserted here — the
 *   reference is minted once, sends go out one at a time oldest-first, a
 *   refusal is kept for a person to decide about, and a failure that smells of
 *   the network never costs a sale. The server's half of the same promise ("a
 *   reference sent twice is one sale") is asserted against a real Postgres by
 *   `npm run validate:migrations`, because a claim about what the database
 *   stores cannot be proven in JavaScript.
 *
 *   The *cache and drafts* are read-through wrappers, so what is asserted is
 *   the fallback: with the network gone the till still searches, pages, scans
 *   and holds — and says which numbers it is unsure of.
 *
 * The store under test is the memory one. IndexedDB is a browser API and is
 * covered where it belongs (the storage seam in `store.ts` exists precisely so
 * this file does not need one); what matters here is that nothing in the layer
 * assumes the store is fast, ordered or able to survive a reload.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createMemoryStore } from './memory-store'
import type { OfflineStore } from './store'
import { WriteQueue, type QueuedWrite, type SendOutcome } from './queue'
import { createCatalogCache } from './catalog-cache'
import { createDraftStore, isLocalDraft } from './drafts'
import { offlineSaleRow, shortRef } from './local-sale'
import { createOfflineRepositories, defaultClassify, describeFailure } from './index'
import { SyncEngine, createSaleSender, type Connectivity } from './sync'
import { addLine, emptyCart, type Cart } from '../../domain/cart'
import type { Milli, Minor } from '../../domain/money'
import type {
  CatalogRepository,
  Repositories,
  SaleRepository,
  SellableProduct,
} from '../contracts'
import type { CompletedSale, SaleRow } from '../../types/records'

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A network failure the way a browser raises one. */
function network(): Error {
  const error = new TypeError('Failed to fetch')
  error.name = 'TypeError'
  return error
}

/** A refusal the way PostgREST raises one: it came back from the server. */
function refused(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

/** A queue on `store`, acting for `org` — the way the app builds one. */
function queueFor(store: OfflineStore, org: string | null = ORG): WriteQueue {
  return new WriteQueue(store, { now: time.now, organizationId: () => org })
}

function product(overrides: Partial<SellableProduct> & { variantId: string }): SellableProduct {
  return {
    productId: `p-${overrides.variantId}`,
    name: 'Soap',
    variantName: null,
    sku: null,
    imageUrl: null,
    price: 10000 as Minor,
    cost: 600000,
    taxRatePercent: 0,
    taxInclusive: false,
    trackStock: true,
    allowNegative: false,
    availableQty: 5000 as Milli,
    unitLabel: 'pc',
    decimalQuantity: false,
    categoryName: 'Home',
    metadata: {},
    ...overrides,
  }
}

/**
 * The shops in these tests.
 *
 * Two of them, because the queue's tenancy is the part worth asserting: a
 * shared till changes hands, and the sales the morning's cashier took must be
 * sent by that shop's session and shown to nobody else.
 */
const ORG = 'org-mekholi'
const OTHER_ORG = 'org-other'

const SOAP = product({ variantId: 'v-soap', name: 'Soap', sku: 'SKU-SOAP' })
const RICE = product({ variantId: 'v-rice', name: 'Rice', sku: 'SKU-RICE', price: 25000 as Minor })

/** A cart holding `quantity` milli-units of one product. */
function cartWith(source: SellableProduct, quantity = 1000): Cart {
  return addLine(
    emptyCart(),
    {
      variantId: source.variantId,
      productId: source.productId,
      name: source.name,
      variantName: source.variantName,
      sku: source.sku,
      unitLabel: source.unitLabel,
      unitPrice: source.price,
      unitCost: source.cost as never,
      taxRatePercent: source.taxRatePercent,
      taxInclusive: source.taxInclusive,
      trackStock: source.trackStock,
      allowNegative: source.allowNegative,
      availableQty: source.availableQty,
      decimalQuantity: source.decimalQuantity,
    },
    quantity as Milli
  )
}

const COMPLETED: CompletedSale = {
  sale_id: 'server-sale-1',
  invoice_no: 'INV-2026-000042',
  status: 'COMPLETED',
  subtotal: '100.00',
  discount: '0.00',
  tax: '0.00',
  total: '100.00',
  paid: '100.00',
  change_due: '0.00',
}

function serverRow(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    id: COMPLETED.sale_id,
    invoice_no: COMPLETED.invoice_no,
    status: 'COMPLETED',
    branch_id: 'b-1',
    register_id: null,
    session_id: null,
    customer_id: null,
    currency: 'BDT',
    subtotal: COMPLETED.subtotal,
    discount_total: COMPLETED.discount,
    discount_type: null,
    discount_value: null,
    tax_total: COMPLETED.tax,
    total: COMPLETED.total,
    paid_total: COMPLETED.paid,
    change_due: COMPLETED.change_due,
    cogs: '0.00',
    profit: '0.00',
    note: null,
    created_at: '2026-09-25T10:00:00.000Z',
    completed_at: '2026-09-25T10:00:00.000Z',
    created_by: null,
    customer: null,
    items: [],
    ...overrides,
  }
}

/**
 * The repository surface, with the two members the offline layer actually
 * wraps. The rest is a throwing stub on purpose: if the offline layer ever
 * starts delegating something it should not, a test fails loudly rather than
 * silently reaching for the network.
 */
function fakeRepositories(overrides: {
  catalog?: Partial<CatalogRepository>
  sales?: Partial<SaleRepository>
} = {}): Repositories {
  const notWrapped = (name: string) => () => {
    throw new Error(`${name} should not be called through the offline layer`)
  }

  const catalog = {
    searchProducts: notWrapped('catalog.searchProducts'),
    findByBarcode: notWrapped('catalog.findByBarcode'),
    findByVariantId: notWrapped('catalog.findByVariantId'),
    listCategories: notWrapped('catalog.listCategories'),
    listBrands: notWrapped('catalog.listBrands'),
    listUnits: notWrapped('catalog.listUnits'),
    listTaxes: notWrapped('catalog.listTaxes'),
    listPaymentMethods: notWrapped('catalog.listPaymentMethods'),
    ...overrides.catalog,
  }

  const sales = {
    complete: notWrapped('sales.complete'),
    hold: notWrapped('sales.hold'),
    resume: notWrapped('sales.resume'),
    discard: notWrapped('sales.discard'),
    list: notWrapped('sales.list'),
    listAll: notWrapped('sales.listAll'),
    detail: notWrapped('sales.detail'),
    get: notWrapped('sales.get'),
    held: notWrapped('sales.held'),
    byCustomer: notWrapped('sales.byCustomer'),
    ...overrides.sales,
  }

  // Only the two wrapped families are described; the layer is spreading `next`
  // over the rest, which it is never expected to touch. The cast names that
  // intent instead of stubbing twenty methods nobody asserts on.
  return { catalog, sales } as unknown as Repositories
}

/** A clock a test can move by hand. */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return { now: () => value, advance: (ms) => (value += ms) }
}

let store: OfflineStore
let time: ReturnType<typeof clock>

beforeEach(() => {
  time = clock()
  store = createMemoryStore(time.now)
})

// ── The queue ─────────────────────────────────────────────────────────────

describe('the write queue', () => {
  it('mints the reference once, so the receipt and the resend agree', async () => {
    const queue = queueFor(store)
    const write = await queue.enqueue('sale.complete', { a: 1 })

    expect(write.ref).toBeTruthy()
    expect(write.id).toBe(write.ref)
    expect(write.attempts).toBe(0)
    expect(write.status).toBe('pending')
    expect((await queue.pending()).map((entry) => entry.ref)).toEqual([write.ref])
  })

  it('sends oldest first, one at a time', async () => {
    const queue = queueFor(store)
    const first = await queue.enqueue('sale.complete', { n: 1 })
    time.advance(1000)
    const second = await queue.enqueue('sale.complete', { n: 2 })

    const order: string[] = []
    let inFlight = 0
    let overlapped = false

    await queue.drain(async (write) => {
      if (inFlight > 0) overlapped = true
      inFlight += 1
      await Promise.resolve()
      order.push(write.ref)
      inFlight -= 1
      return { ok: true }
    })

    expect(order).toEqual([first.ref, second.ref])
    expect(overlapped).toBe(false)
    expect(await queue.size()).toBe(0)
  })

  it('keeps a write the network refused, and stops rather than burning through the queue', async () => {
    const queue = queueFor(store)
    const write = await queue.enqueue('sale.complete', { n: 1 })
    const attempted: string[] = []

    await queue.drain(async (candidate) => {
      attempted.push(candidate.ref)
      return { ok: false, failure: 'offline', message: 'Failed to fetch' }
    })

    // The write is still there, with a record of the attempt.
    const kept = (await queue.pending())[0]
    expect(kept?.ref).toBe(write.ref)
    expect(kept?.attempts).toBe(1)
    expect(kept?.lastAttemptAt).toBe(time.now())
    expect(kept?.lastError).toBe('Failed to fetch')
    expect(attempted).toEqual([write.ref])
  })

  it('stops at the first offline write instead of reordering the ones behind it', async () => {
    const queue = queueFor(store)
    const first = await queue.enqueue('sale.complete', { n: 1 })
    time.advance(1000)
    const second = await queue.enqueue('sale.complete', { n: 2 })
    const attempted: string[] = []

    await queue.drain(async (candidate) => {
      attempted.push(candidate.ref)
      return candidate.ref === first.ref
        ? { ok: false, failure: 'offline', message: 'offline' }
        : { ok: true }
    })

    // The second sale is *behind* the first in time; sending it while the first
    // is unresolved would put the shop's invoice numbers out of order.
    expect(attempted).toEqual([first.ref])
    expect((await queue.pending()).map((entry) => entry.ref)).toEqual([first.ref, second.ref])
  })

  it('marks a refused write failed, and carries on with the rest', async () => {
    const queue = queueFor(store)
    const refusedWrite = await queue.enqueue('sale.complete', { n: 1 })
    time.advance(1000)
    const fine = await queue.enqueue('sale.complete', { n: 2 })

    const result = await queue.drain(async (write) =>
      write.ref === refusedWrite.ref
        ? { ok: false, failure: 'refused', message: 'insufficient stock: Rice' }
        : { ok: true }
    )

    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.stopped).toBe(false)

    const failures = await queue.failures()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.ref).toBe(refusedWrite.ref)
    expect(failures[0]?.lastError).toBe('insufficient stock: Rice')
    // The queued sale is *kept*: somebody has to decide, and a sale thrown away
    // silently is money the shop cannot account for. It is out of the pending
    // list, so the drain will not try it again on its own.
    expect((await queue.pending()).map((entry) => entry.ref)).toEqual([])
    // One write is gone (delivered) and one is kept (refused).
    expect(await queue.size()).toBe(1)
    expect(fine.ref).toBeTruthy()
  })

  it('skips a failed write on the next drain, until a person retries it', async () => {
    const queue = queueFor(store)
    const write = await queue.enqueue('sale.complete', { n: 1 })
    await queue.drain(async () => ({ ok: false, failure: 'refused', message: 'no' }))

    const second: string[] = []
    await queue.drain(async (candidate) => {
      second.push(candidate.ref)
      return { ok: true }
    })
    expect(second).toEqual([])

    expect(await queue.retry(write.ref)).toBe(true)
    const third: string[] = []
    await queue.drain(async (candidate) => {
      third.push(candidate.ref)
      return { ok: true }
    })
    expect(third).toEqual([write.ref])
    expect(await queue.size()).toBe(0)
  })

  it('hands a discarded write back, so the caller can say what was thrown away', async () => {
    const queue = queueFor(store)
    const write = await queue.enqueue('sale.complete', { n: 1 })

    const removed = await queue.discard(write.ref)
    expect(removed?.ref).toBe(write.ref)
    expect(await queue.discard('not-there')).toBeNull()
    expect(await queue.size()).toBe(0)
  })

  it('will not hold a sale that belongs to no shop', async () => {
    // Better a loud failure at the till than a write nobody is allowed to send:
    // a sale with no organization would sit in the queue forever, and the shop
    // would find out at closing time.
    const queue = queueFor(store, null)
    await expect(queue.enqueue('sale.complete', { n: 1 })).rejects.toThrow(/signed-in shop/)
  })

  it('keeps one shop’s sales out of another’s way', async () => {
    const queue = queueFor(store)
    await queue.enqueue('sale.complete', { n: 1 }, { organizationId: ORG })
    await queue.enqueue('sale.complete', { n: 2 }, { organizationId: OTHER_ORG })

    // Each shop sees its own…
    expect((await queue.pending(ORG)).map((w) => w.payload)).toEqual([{ n: 1 }])
    expect((await queue.pending(OTHER_ORG)).map((w) => w.payload)).toEqual([{ n: 2 }])

    // …and the drain of one never touches the other's sale.
    const sent: unknown[] = []
    const result = await queue.drain(
      async (write) => {
        sent.push(write.payload)
        return { ok: true }
      },
      { organizationId: ORG }
    )

    expect(sent).toEqual([{ n: 1 }])
    expect(result).toEqual({ sent: 1, failed: 0, stopped: false, remaining: 0 })
    expect((await queue.pending(OTHER_ORG)).map((w) => w.payload)).toEqual([{ n: 2 }])
    // And the device still knows about it: it is waiting, not lost.
    expect((await queue.foreign(ORG)).map((w) => w.payload)).toEqual([{ n: 2 }])
  })

  it('lets only the owning shop retry or discard a queued sale', async () => {
    const queue = queueFor(store)
    const write = await queue.enqueue('sale.complete', { n: 1 }, { organizationId: OTHER_ORG })

    // The other shop's session cannot throw away or re-send what it cannot see.
    expect(await queue.discard(write.ref)).toBeNull()
    expect(await queue.retry(write.ref)).toBe(false)
    expect(await queue.size()).toBe(1)
  })

  it('reads a queued write back by reference — the receipt the till kept', async () => {
    const queue = queueFor(store)
    const write = await queue.enqueue('sale.complete', { n: 1 }, { meta: { row: { id: 'r' } } })

    expect((await queue.find(write.ref))?.meta).toEqual({ row: { id: 'r' } })
    expect(await queue.find('nope')).toBeNull()
  })

  it('treats a duplicate reference from the server as success, not as a refusal', async () => {
    // 23505 is the unique index on (organization_id, client_ref) doing its job:
    // the sale is already recorded, which is the outcome the queue wanted.
    const send = createSaleSender(
      async () => {
        throw refused('23505', 'duplicate key value violates unique constraint')
      },
      defaultClassify,
      describeFailure
    )

    const outcome = await send({
      id: 'r',
      ref: 'r',
      kind: 'sale.complete',
      payload: {},
      createdAt: 0,
      attempts: 1,
      lastAttemptAt: 0,
      status: 'pending',
      lastError: null,
      organizationId: ORG,
    } satisfies QueuedWrite)

    expect(outcome.ok).toBe(true)
  })
})

// ── Classification ────────────────────────────────────────────────────────

describe('telling the network apart from the shop’s rules', () => {
  it('reads a SQLSTATE as the server having spoken', () => {
    expect(defaultClassify(refused('23505', 'dup'))).toBe('refused')
    expect(defaultClassify(refused('42501', 'forbidden'))).toBe('refused')
  })

  it('reads a failed fetch as not having asked at all', () => {
    expect(defaultClassify(network())).toBe('offline')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(defaultClassify(abort)).toBe('offline')
    expect(defaultClassify(new Error('something else'))).toBe('offline')
  })

  it('says something a shopkeeper can read', () => {
    expect(describeFailure(new Error('insufficient stock'))).toBe('insufficient stock')
    expect(describeFailure(refused('23505', 'dup'))).toBe('dup')
    expect(describeFailure(undefined)).toBe('The sale could not be sent.')
  })
})

// ── The catalogue cache ───────────────────────────────────────────────────

describe('the catalogue cache', () => {
  it('answers a search from the cache when the network is gone', async () => {
    let online = true
    const cache = createCatalogCache(
      {
        searchProducts: async () => {
          if (!online) throw network()
          return { items: [SOAP, RICE], nextCursor: null }
        },
      } as unknown as CatalogRepository,
      store,
      { now: time.now }
    )

    await cache.repository.searchProducts({ warehouseId: 'w-1', limit: 50 })
    online = false

    const page = await cache.repository.searchProducts({ warehouseId: 'w-1', limit: 50, search: 'rice' })
    expect(page.items.map((row) => row.variantId)).toEqual(['v-rice'])
  })

  it('pages over a stable snapshot, so the same query returns the same order', async () => {
    // Warm the store directly: this test is about the offline paging rules,
    // not about how the rows got there.
    await store.put('catalog', 'variant:v-b', product({ variantId: 'v-b', name: 'B' }))
    await store.put('catalog', 'variant:v-a', product({ variantId: 'v-a', name: 'A' }))
    await store.put('catalog', 'variant:v-c', product({ variantId: 'v-c', name: 'C' }))

    const cache = createCatalogCache(
      {
        searchProducts: async () => {
          throw network()
        },
      } as unknown as CatalogRepository,
      store,
      { now: time.now }
    )

    const first = await cache.repository.searchProducts({ warehouseId: 'w-1', limit: 2 })
    expect(first.items.map((row) => row.name)).toEqual(['A', 'B'])
    expect(first.nextCursor).toBe('2')

    const second = await cache.repository.searchProducts({
      warehouseId: 'w-1',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map((row) => row.name)).toEqual(['C'])
    expect(second.nextCursor).toBeNull()
  })

  it('throws when it has nothing cached, rather than showing an empty shop', async () => {
    const cache = createCatalogCache(
      {
        searchProducts: async () => {
          throw network()
        },
      } as unknown as CatalogRepository,
      store,
      { now: time.now }
    )

    await expect(cache.repository.searchProducts({ warehouseId: 'w-1' })).rejects.toThrow(
      'Failed to fetch'
    )
  })

  it('scans a barcode offline by SKU, and remembers what it saw online', async () => {
    let online = true
    const cache = createCatalogCache(
      {
        searchProducts: async () =>
          online ? { items: [RICE], nextCursor: null } : (() => { throw network() })(),
        findByBarcode: async () => {
          if (!online) throw network()
          return RICE
        },
      } as unknown as CatalogRepository,
      store,
      { now: time.now }
    )

    await cache.repository.searchProducts({ warehouseId: 'w-1' })
    online = false

    const found = await cache.repository.findByBarcode('SKU-RICE', 'w-1')
    expect(found?.variantId).toBe('v-rice')
    // A code the shop does not stock is answered, not thrown: the cache has a
    // catalogue in it, so "no such product" is something the till knows.
    expect(await cache.repository.findByBarcode('SKU-NOTHING', 'w-1')).toBeNull()
  })

  it('refuses to answer a scan from an empty cache, rather than denying the shop sells it', async () => {
    const cache = createCatalogCache(
      {
        findByBarcode: async () => {
          throw network()
        },
      } as unknown as CatalogRepository,
      store,
      { now: time.now }
    )

    await expect(cache.repository.findByBarcode('SKU-RICE', 'w-1')).rejects.toThrow('Failed to fetch')
  })

  it('reports its age and size, because a cached price is a fact with a date', async () => {
    const cache = createCatalogCache(
      {
        searchProducts: async () => ({ items: [SOAP], nextCursor: null }),
        listCategories: async () => [],
        listBrands: async () => [],
        listUnits: async () => [],
        listTaxes: async () => [],
        listPaymentMethods: async () => [],
      } as unknown as CatalogRepository,
      store,
      { now: time.now }
    )

    expect(await cache.cachedAt()).toBeNull()
    const warm = await cache.warm('w-1')
    expect(warm.rows).toBe(1)
    expect(warm.complete).toBe(true)
    expect(await cache.cachedAt()).toBe(time.now())
    expect(await cache.size()).toBeGreaterThan(0)

    await cache.clear()
    expect(await cache.size()).toBe(0)
  })
})

// ── Drafts ────────────────────────────────────────────────────────────────

describe('held carts while offline', () => {
  it('parks a cart under a local id, and finds it again by branch', async () => {
    const drafts = createDraftStore(store, time.now)
    const draft = await drafts.save({
      branchId: 'b-1',
      customerId: null,
      note: 'customer stepped out',
      items: [{ variantId: 'v-soap', qty: 2000 }],
    })

    expect(isLocalDraft(draft.id)).toBe(true)
    expect((await drafts.list('b-1')).map((entry) => entry.id)).toEqual([draft.id])
    expect(await drafts.list('b-2')).toEqual([])

    await drafts.remove(draft.id)
    expect(await drafts.get(draft.id)).toBeNull()
  })

  it('resumes with the stored items and required-but-null discounts', async () => {
    const drafts = createDraftStore(store, time.now)
    const draft = await drafts.save({
      branchId: 'b-1',
      customerId: 'c-1',
      note: '',
      items: [{ variantId: 'v-soap', qty: 1500 }],
    })

    const resumed = drafts.asResumed(draft)
    expect(resumed.sale_id).toBe(draft.id)
    // Decimal units, exactly as `resume_sale` returns them, because the resume
    // path parses them with `parseMilli`. Milli here would come back ×1000.
    expect(resumed.items).toEqual([
      { variant_id: 'v-soap', qty: '1.5', discount_type: null, discount_value: null },
    ])
    expect(resumed.customer_id).toBe('c-1')
  })

  it('renders a local draft as a held row with no money claimed', async () => {
    const drafts = createDraftStore(store, time.now)
    const draft = await drafts.save({
      branchId: 'b-1',
      customerId: null,
      note: '',
      items: [{ variantId: 'v-soap', qty: 1000 }],
    })

    const row = drafts.asRow(draft)
    expect(row.invoice_no).toBe('Draft')
    expect(row.status).toBe('HELD')
    expect(row.total).toBe('0.00')
    // Deliberately no line items. The draft holds variant ids and quantities;
    // turning those into named, priced lines is the resume path's job, and a
    // row that invented names here would be a second place for them to differ.
    expect(row.items).toBeUndefined()
  })
})

// ── The repositories ──────────────────────────────────────────────────────

describe('the offline repositories', () => {
  it('queues a sale the network would not take, and returns a printable sale', async () => {
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          complete: async () => {
            throw network()
          },
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    const cart = cartWith(SOAP, 1000)
    const sale = await offline.repositories.sales.complete({
      branchId: 'b-1',
      registerId: 'r-1',
      warehouseId: 'w-1',
      customerId: null,
      items: [{ variant_id: 'v-soap', qty: 1000 }],
      payments: [],
      local: { cart, currency: 'BDT', sessionId: 's-1' },
    })

    expect(sale.queued).toBe(true)
    // The amount is the cart's own arithmetic, not a zero placeholder: the
    // cashier reads this number back to the customer.
    expect(sale.total).toBe('100.00')
    expect(sale.invoice_no).toBe('Not yet numbered')

    // And the slip the customer takes is retrievable while it waits, so the
    // POS can print it from the same code path as an online sale.
    const row = await offline.repositories.sales.get(sale.sale_id)
    expect(row?.id).toBe(sale.sale_id)
    expect(row?.invoice_no).toBe('Not yet numbered')
    expect(row?.total).toBe('100.00')
    expect(row?.items?.[0]?.product_name).toBe('Soap')
  })

  it('does not serve a queued slip to a cashier of another shop', async () => {
    // The till is shared and the session changed. The slip is somebody's sale
    // with somebody's customer on it, so this session asks the server instead —
    // which answers with whatever RLS allows it, not with this receipt.
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          complete: async () => {
            throw network()
          },
          get: async () => null,
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    const cart = cartWith(SOAP, 1000)
    const sale = await offline.repositories.sales.complete({
      branchId: 'b-1',
      registerId: null,
      warehouseId: 'w-1',
      customerId: 'c-1',
      items: [{ variant_id: 'v-soap', qty: 1000 }],
      payments: [],
      local: { cart, currency: 'BDT' },
    })
    expect(sale.queued).toBe(true)
    expect((await offline.repositories.sales.get(sale.sale_id))?.total).toBe('100.00')

    // The cashier signs out and another shop signs in. Same device, same store —
    // the queue survives, because the sale it holds is money that was taken.
    const otherShop = createOfflineRepositories(
      fakeRepositories({
        sales: { complete: async () => COMPLETED, get: async () => null },
      }),
      { store, now: time.now, organizationId: () => OTHER_ORG }
    )

    // The queue still holds the morning's sale…
    expect(await otherShop.queue.find(sale.sale_id)).not.toBeNull()
    // …and this session is not served its slip.
    expect(await otherShop.repositories.sales.get(sale.sale_id)).toBeNull()

    // Its own sale is queued separately, and its engine sends only that one.
    await otherShop.queue.enqueue('sale.complete', { n: 2 })
    const sent: unknown[] = []
    const engine = new SyncEngine({
      queue: otherShop.queue,
      connectivity: { isOnline: () => true, onChange: () => () => {} },
      send: async (write) => {
        sent.push(write.payload)
        return { ok: true }
      },
      now: time.now,
    })

    const status = await engine.refresh()
    expect(status.pending).toBe(1)
    expect(status.foreign).toBe(1)
    expect((await engine.drain()).sent).toBe(1)
    expect(sent).toEqual([{ n: 2 }])
    // The morning's sale is untouched, and still waiting for its own shop.
    expect(await otherShop.queue.size(ORG)).toBe(1)
    expect(await otherShop.queue.pending(ORG)).toHaveLength(1)
  })

  it('hands back the server’s row once the queue has delivered it', async () => {
    let online = false
    const sent: unknown[] = []
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          complete: async (input) => {
            if (!online) throw network()
            sent.push(input)
            return COMPLETED
          },
          get: async () => serverRow(),
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    const cart = cartWith(SOAP, 1000)
    const sale = await offline.repositories.sales.complete({
      branchId: 'b-1',
      registerId: null,
      warehouseId: 'w-1',
      customerId: null,
      items: [{ variant_id: 'v-soap', qty: 1000 }],
      payments: [],
      local: { cart, currency: 'BDT' },
    })
    expect(sale.queued).toBe(true)

    online = true
    const engine = new SyncEngine({
      queue: offline.queue,
      connectivity: { isOnline: () => true, onChange: () => () => {} },
      send: createSaleSender(
        // The real transport: the queued payload goes back to the *unwrapped*
        // repository. It is the same function the app hands the engine.
        async (payload) => {
          sent.push(payload)
          return COMPLETED
        },
        defaultClassify,
        describeFailure
      ),
      now: time.now,
    })
    await engine.refresh()
    await engine.drain()

    expect(sent).toHaveLength(1)
    // The reference travelled with the payload, unchanged, which is what makes
    // the server able to recognise a replay.
    expect((sent[0] as { clientRef?: string }).clientRef).toBe(sale.sale_id)
    expect(await offline.queue.size()).toBe(0)

    // Now the server owns the sale, so `get` answers from the server.
    const row = await offline.repositories.sales.get(sale.sale_id)
    expect(row?.invoice_no).toBe('INV-2026-000042')
  })

  it('never sends the till’s copy of the cart to the server', async () => {
    const sent: unknown[] = []
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          complete: async (input) => {
            sent.push(input)
            return COMPLETED
          },
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    await offline.repositories.sales.complete({
      branchId: 'b-1',
      registerId: null,
      warehouseId: 'w-1',
      customerId: null,
      items: [{ variant_id: 'v-soap', qty: 1000 }],
      payments: [],
      local: { cart: cartWith(SOAP), currency: 'BDT' },
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toHaveProperty('local')
    // What is sent is the wire shape the RPC reads, and the reference.
    expect(sent[0]).toMatchObject({ branchId: 'b-1', items: [{ variant_id: 'v-soap' }] })
    expect(typeof (sent[0] as { clientRef?: string }).clientRef).toBe('string')
  })

  it('passes a refusal straight back — the server’s answer is the shop’s answer', async () => {
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          complete: async () => {
            throw refused('P0001', 'insufficient stock: Soap')
          },
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    await expect(
      offline.repositories.sales.complete({
        branchId: 'b-1',
        registerId: null,
        warehouseId: 'w-1',
        customerId: null,
        items: [{ variant_id: 'v-soap', qty: 1000 }],
        payments: [],
      })
    ).rejects.toThrow('insufficient stock: Soap')

    // Nothing was queued: a refusal is not something to try again later.
    expect(await offline.queue.size()).toBe(0)
  })

  it('keeps a held cart as a local draft when the server cannot be reached', async () => {
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          hold: async () => {
            throw network()
          },
          held: async () => {
            throw network()
          },
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    const id = await offline.repositories.sales.hold({
      branchId: 'b-1',
      customerId: null,
      items: [{ variant_id: 'v-soap', qty: 1000 }],
    })
    expect(isLocalDraft(id)).toBe(true)

    const held = await offline.repositories.sales.held('b-1')
    expect(held.map((row) => row.id)).toEqual([id])

    const resumed = await offline.repositories.sales.resume(id)
    expect(resumed.items[0]?.variant_id).toBe('v-soap')
  })

  it('discards a local draft by dropping it, with no server call', async () => {
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          hold: async () => {
            throw network()
          },
          held: async () => {
            throw network()
          },
          // Must never be reached for a local draft — there is no server row.
          discard: async () => {
            throw new Error('the server should not be asked to discard a local draft')
          },
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    const id = await offline.repositories.sales.hold({
      branchId: 'b-1',
      customerId: null,
      items: [{ variant_id: 'v-soap', qty: 1000 }],
    })
    expect(isLocalDraft(id)).toBe(true)

    await offline.repositories.sales.discard(id)

    const held = await offline.repositories.sales.held('b-1').catch(() => [])
    expect(held.map((row) => row.id)).not.toContain(id)
  })

  it('sends a server-held sale to the discard RPC', async () => {
    const discarded: string[] = []
    const offline = createOfflineRepositories(
      fakeRepositories({
        sales: {
          discard: async (saleId: string) => {
            discarded.push(saleId)
          },
        },
      }),
      { store, now: time.now, organizationId: () => ORG }
    )

    await offline.repositories.sales.discard('sale-123')
    expect(discarded).toEqual(['sale-123'])
  })
})

// ── The engine ────────────────────────────────────────────────────────────

describe('the sync engine', () => {
  /** A flag a test flips, standing in for the browser's. */
  function connectivity(initial = true): Connectivity & { set(online: boolean): void } {
    let online = initial
    const listeners = new Set<(value: boolean) => void>()
    return {
      isOnline: () => online,
      onChange(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set(value) {
        online = value
        for (const listener of listeners) listener(value)
      },
    }
  }

  it('publishes what the till is holding, and drains when the connection returns', async () => {
    const net = connectivity(false)
    const queue = queueFor(store)
    await queue.enqueue('sale.complete', { n: 1 })
    await queue.enqueue('sale.complete', { n: 2 })

    const seen: number[] = []
    const engine = new SyncEngine({
      queue,
      connectivity: net,
      send: async (): Promise<SendOutcome> => ({ ok: true }),
      now: time.now,
      onStatus: (status) => seen.push(status.pending),
    })

    await engine.start()
    expect(engine.status.pending).toBe(2)
    expect(engine.status.online).toBe(false)

    net.set(true)
    // The drain is asynchronous and deliberately not awaited by the listener:
    // connectivity events must not block the UI. One macrotask is enough for
    // the queue's own promise chain.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(engine.status.pending).toBe(0)
    expect(engine.status.lastSyncedAt).toBe(time.now())
    expect(seen).toContain(2)
  })

  it('keeps trying on a timer while something is waiting, without piling up timers', async () => {
    const net = connectivity(true)
    const queue = queueFor(store)
    await queue.enqueue('sale.complete', { n: 1 })

    let sends = 0
    // A timer harness that behaves like `setTimeout`: one-shot, and no longer
    // cancellable once it has fired. "One live timer at a time" is exactly the
    // property under test — a `setInterval` racing a slow upload is how a queue
    // sends the same sale twice, and a wrapper that cleared the engine's handle
    // on the wrong tick would hide that.
    const timers = new Map<number, () => void>()
    let nextHandle = 0
    const engine = new SyncEngine({
      queue,
      connectivity: net,
      send: async () => {
        sends += 1
        // The connection is there but the send keeps failing: the engine must
        // re-arm rather than spin.
        return { ok: false, failure: 'offline', message: 'gateway timeout' }
      },
      now: time.now,
      setTimer: (fn) => {
        nextHandle += 1
        const handle = nextHandle
        timers.set(handle, () => {
          timers.delete(handle)
          fn()
        })
        return handle
      },
      clearTimer: (handle) => {
        timers.delete(handle)
      },
    })

    await engine.start()
    // start() drains once immediately (there is work and the flag says online).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sends).toBe(1)
    expect(timers.size).toBe(1)

    // Firing the live timer sends again and re-arms exactly one, and only one.
    const live = [...timers.values()][0]
    live?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sends).toBe(2)
    expect(timers.size).toBe(1)
    // The write is still there, still pending: nothing was lost by failing.
    expect(await queue.pending()).toHaveLength(1)

    // Nothing re-arms after a stop, so a signed-out till does not keep trying.
    engine.stop()
    expect(timers.size).toBe(0)
  })

  it('lets a person retry a refused sale by hand', async () => {
    const queue = queueFor(store)
    const write = await queue.enqueue('sale.complete', { n: 1 })
    await queue.drain(async () => ({ ok: false, failure: 'refused', message: 'insufficient stock' }))

    const engine = new SyncEngine({
      queue,
      connectivity: { isOnline: () => false, onChange: () => () => {} },
      send: async () => ({ ok: true }),
      now: time.now,
    })
    await engine.refresh()

    const failures = await engine.failures()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ ref: write.ref, attempts: 1, message: 'insufficient stock' })

    await engine.retry(write.ref)
    await engine.drain()
    expect(await queue.size()).toBe(0)

    // And discarding is how a shopkeeper closes the book on one they will not send.
    const other = await queue.enqueue('sale.complete', { n: 2 })
    await queue.drain(async () => ({ ok: false, failure: 'refused', message: 'no' }))
    const removed = await engine.discard(other.ref)
    expect(removed?.ref).toBe(other.ref)
    expect(await queue.size()).toBe(0)
  })
})

// ── The slip ──────────────────────────────────────────────────────────────

describe('the offline slip', () => {
  it('carries the reference the customer can be asked for', () => {
    expect(shortRef('0f8a4c3e-1111-4222-8333-abc9e7f61d20')).toBe('F61D20')
  })

  it('totals the cart the way the screen did, and says the number is coming', () => {
    const row = offlineSaleRow({
      ref: '0f8a4c3e-1111-4222-8333-abc9e7f61d20',
      cart: cartWith(SOAP, 2500),
      branchId: 'b-1',
      registerId: null,
      sessionId: null,
      currency: 'BDT',
      at: '2026-09-25T10:00:00.000Z',
    })

    expect(row.total).toBe('250.00')
    expect(row.invoice_no).toBe('Not yet numbered')
    expect(row.status).toBe('COMPLETED')
    expect(row.note).toContain('F61D20')
    expect(row.items?.[0]?.quantity).toBe('2.5')
  })
})
