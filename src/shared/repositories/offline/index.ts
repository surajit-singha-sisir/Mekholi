/**
 * The offline repositories (docs/10 Phase 8).
 *
 * Same contracts, different guarantees, and the difference is written down
 * rather than discovered:
 *
 *   | call                     | online                      | offline                        |
 *   |--------------------------|-----------------------------|--------------------------------|
 *   | catalog.*                | network, then cached        | cached, labelled with its age  |
 *   | sales.complete           | server decides, server numbers | queued, receipt printed locally |
 *   | sales.hold / resume      | server row                  | a local draft (`draft:` id)   |
 *   | everything else          | unchanged                   | throws — see below             |
 *
 * The last row is deliberate. Caching a refund, a stock take or a report would
 * mean inventing an answer that looks like the server's; a screen that cannot
 * reach the server has to say so. The till keeps working, and everything else
 * waits — which is the honest half of "offline".
 *
 * `clientRef` is the spine. It is minted once, before the first attempt, put on
 * the queued payload and never regenerated, so a resend after an unclear
 * outcome is recognised by the server (migration 044) as the sale it already
 * wrote. Nothing in this file decides a price, a total or a stock level.
 */

import type { CatalogRepository, Repositories, SaleRepository } from '../contracts'
import type { CompletedSale, SaleRow } from '../../types/records'
import { createCatalogCache, type CatalogCacheOptions } from './catalog-cache'
import { createDraftStore, isLocalDraft } from './drafts'
import { OFFLINE_LABEL, offlineSaleRow } from './local-sale'
import { WriteQueue, type SendFailure, type QueuedWrite } from './queue'
import type { OfflineStore } from './store'

/**
 * Was that the network, or the shop's rule?
 *
 * `fetch` failures surface as `TypeError` in browsers and as an error with a
 * `name` of `AbortError`/`NetworkError`; PostgREST answers arrive as objects
 * with a `code`. Anything that came back *from the server* is a refusal — the
 * server had its say and repeating the question changes nothing. Everything
 * else is treated as "we could not ask", which is the safe reading: a write
 * that waits is recoverable, a write marked failed by mistake is a sale the
 * shopkeeper has to chase.
 */
export function defaultClassify(error: unknown): SendFailure {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

  const record = asRecord(error)
  // A PostgREST error carries a SQLSTATE; so does a plpgsql `raise … errcode`.
  if (record && typeof record.code === 'string' && record.code.length > 0) return 'refused'
  if (typeof error === 'string' && /\b(4\d\d|5\d\d)\b/.test(error)) return 'refused'

  const name = record && typeof record.name === 'string' ? record.name : ''
  if (name === 'AbortError' || name === 'NetworkError' || name === 'TypeError') return 'offline'

  return 'offline'
}

export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null
  if (record && typeof record.message === 'string') return record.message
  return 'The sale could not be sent.'
}

export interface OfflineRepositories {
  /** The whole surface, ready for the composition root to hand out. */
  repositories: Repositories
  queue: WriteQueue
  cache: ReturnType<typeof createCatalogCache>
  drafts: ReturnType<typeof createDraftStore>
  /** Pull the catalogue in. Called when a session starts, and by hand. */
  warm(warehouseId: string): Promise<{ rows: number; complete: boolean }>
  /** True when the store survives a reload (IndexedDB rather than memory). */
  persistent: boolean
}

export interface OfflineOptions {
  store: OfflineStore
  /**
   * The shop the session belongs to.
   *
   * A queued sale is the shop's, not the device's: this is what stops the next
   * cashier to sign in — possibly to a different shop — from sending a sale
   * they cannot see, or reading a slip they have no business reading.
   */
  organizationId?: () => string | null
  queue?: WriteQueue
  cache?: CatalogCacheOptions
  now?: () => number
  newRef?: () => string
  classify?: (error: unknown) => SendFailure
  persistent?: boolean
}

export function createOfflineRepositories(next: Repositories, options: OfflineOptions): OfflineRepositories {
  const now = options.now ?? (() => Date.now())
  const classify = options.classify ?? defaultClassify
  const cache = createCatalogCache(next.catalog, options.store, options.cache ?? {})
  const drafts = createDraftStore(options.store, now)
  const queue =
    options.queue ??
    new WriteQueue(options.store, {
      now,
      ...(options.newRef ? { newRef: options.newRef } : {}),
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    })
  // One source for "which shop is this": the queue already knows, because it
  // refuses to hold a write without one.
  const currentOrganization = (): string | null => queue.organizationId()

  const sales: SaleRepository = {
    ...next.sales,

    async complete(input) {
      // The reference exists before the first attempt ever leaves the device,
      // which is what makes the retry safe rather than a second sale.
      const ref = input.clientRef ?? queueRef(options, now)
      // `local` is the till's copy of the sale, for printing; it is not part of
      // what the server is asked to do, so it never goes on the wire.
      const { local, ...wire } = input
      const payload = { ...wire, clientRef: ref }

      try {
        return await next.sales.complete(payload)
      } catch (error) {
        if (classify(error) !== 'offline') throw error

        const at = new Date(now()).toISOString()
        // The slip the customer takes away. Its money is the cart's own
        // arithmetic — the same code that drew the total on screen — and it is
        // marked so nobody mistakes it for the numbered sale that is coming.
        const row: SaleRow | null = local
          ? offlineSaleRow({
              ref,
              cart: local.cart,
              branchId: input.branchId,
              registerId: input.registerId,
              sessionId: local.sessionId ?? null,
              currency: local.currency,
              at,
              note: input.note ?? null,
            })
          : null

        const write = await queue.enqueue('sale.complete', payload, {
          ref,
          ...(row ? { meta: { row } } : {}),
        })
        return {
          sale_id: write.ref,
          invoice_no: row?.invoice_no ?? OFFLINE_LABEL,
          status: 'COMPLETED',
          subtotal: row?.subtotal ?? '0',
          discount: row?.discount_total ?? '0',
          tax: row?.tax_total ?? '0',
          total: row?.total ?? '0',
          paid: row?.paid_total ?? '0',
          change_due: row?.change_due ?? '0',
          queued: true,
          client_ref: write.ref,
        } satisfies CompletedSale
      }
    },

    async hold(input) {
      try {
        return await next.sales.hold(input)
      } catch (error) {
        if (classify(error) !== 'offline') throw error
        // Client wins for drafts: the cart is parked locally, and it is still
        // there after a reload.
        const draft = await drafts.save({
          branchId: input.branchId,
          customerId: input.customerId,
          note: input.note ?? '',
          // The contract already speaks the wire shape (`variant_id`, `qty`),
          // so the draft stores exactly what the caller handed over — no
          // second interpretation of an item.
          items: input.items.map((item) => ({
            variantId: item.variant_id,
            qty: item.qty,
            ...(item.discount_type ? { discountType: item.discount_type } : {}),
            ...(item.discount_value !== undefined ? { discountValue: item.discount_value } : {}),
          })),
        })
        return draft.id
      }
    },

    async resume(saleId) {
      if (!isLocalDraft(saleId)) return next.sales.resume(saleId)
      const draft = await drafts.get(saleId)
      if (!draft) throw new Error('That held cart is no longer on this device.')
      return drafts.asResumed(draft)
    },

    async discard(saleId) {
      // A cart parked offline only ever lived on this device — throwing it away
      // is a local delete, and needs no server.
      if (isLocalDraft(saleId)) {
        await drafts.remove(saleId)
        return
      }
      return next.sales.discard(saleId)
    },

    /**
     * A queued sale is still a sale to everybody standing at the counter.
     *
     * The POS asks for the row it just completed in order to print it. While
     * that sale sits in the queue the server has no row to give, so the till
     * answers from the slip it kept with the write. Once the queue delivers it,
     * the write is gone and this falls through to the server — which is also
     * how the printed slip and the stored sale end up agreeing: the copy is
     * never consulted again after the real one exists.
     */
    async get(id) {
      const write = await queue.find(id)
      // A slip kept for a queued sale is served only to the shop that took it.
      // To anybody else this is a sale they may not read, so the question goes
      // to the server, which has RLS and answers with whatever they are allowed
      // — a 404 for a stranger, the row for a colleague of the same shop.
      const mine = write !== null && write.organizationId === currentOrganization()
      const row = mine ? receiptOf(write) : null
      if (row) return row

      return next.sales.get(id)
    },

    async held(branchId) {
      const local = (await drafts.list(branchId)).map((draft) => drafts.asRow(draft))
      try {
        const remote = await next.sales.held(branchId)
        return [...local, ...remote]
      } catch (error) {
        if (classify(error) !== 'offline') throw error
        // Offline, the shop still sees its own parked carts — which are the
        // ones a cashier on this device can actually resume.
        return local
      }
    },
  }

  const repositories: Repositories = {
    ...next,
    catalog: cache.repository as CatalogRepository,
    sales,
  }

  return {
    repositories,
    queue,
    cache,
    drafts,
    persistent: options.persistent ?? true,
    async warm(warehouseId) {
      return cache.warm(warehouseId)
    },
  }
}

/**
 * The receipt kept with a queued write, if there is one.
 *
 * `meta` is untyped on purpose — the queue is a transport and should not know
 * what a receipt is — so the shape is checked here, once, where it is used.
 */
function receiptOf(write: QueuedWrite): SaleRow | null {
  const meta = write.meta
  if (typeof meta !== 'object' || meta === null) return null
  const row = (meta as { row?: unknown }).row
  if (typeof row !== 'object' || row === null) return null
  const candidate = row as Partial<SaleRow>
  return typeof candidate.id === 'string' && typeof candidate.total === 'string'
    ? (row as SaleRow)
    : null
}

/** The reference generator, kept here so both paths mint it the same way. */
function queueRef(options: OfflineOptions, now: () => number): string {
  if (options.newRef) return options.newRef()
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `ref-${now()}-${Math.random().toString(36).slice(2)}`
}
