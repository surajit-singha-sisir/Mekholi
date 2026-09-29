/**
 * Stock history for one variant (Phase 3, spec §12).
 *
 * "Why is this 37 units?" is the question every stock number provokes, and the
 * ledger is the only honest answer to it. So this screen shows exactly that:
 * every movement, newest first, each one stating the quantity before it, what
 * it changed to, and what caused it. The running balance is not decoration —
 * if the arithmetic on screen does not add up, the shopkeeper should be able
 * to see that, not be told to trust a total.
 *
 * The movement types are translated into the words a shopkeeper would use.
 * 'ADJUSTMENT_OUT' is a database word; "Damaged" is what happened.
 */

import { h, mount } from '../../components/ui/h'
import { button, iconButton, spinner } from '../../components/ui/button'
import { badge, card, emptyState } from '../../components/ui/card'
import { toastError } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization } from '../../app/state/session'
import { salesFloor } from '../../app/state/sales-floor'
import { formatMoney, formatQty } from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { StockMovementRow, StockRow } from '../../shared/repositories/contracts'

export interface StockHistoryOptions {
  variantId: string
  onBack: () => void
}

/** Ledger vocabulary → shopkeeper vocabulary. */
const TYPE_LABELS: Record<string, { label: string; icon: string; tone: 'success' | 'danger' | 'neutral' | 'warning' }> = {
  OPENING_STOCK: { label: 'Opening stock', icon: 'flag', tone: 'neutral' },
  PURCHASE: { label: 'Received', icon: 'add_box', tone: 'success' },
  SALE: { label: 'Sold', icon: 'point_of_sale', tone: 'neutral' },
  RETURN_IN: { label: 'Customer return', icon: 'assignment_return', tone: 'success' },
  RETURN_OUT: { label: 'Returned to supplier', icon: 'assignment_return', tone: 'danger' },
  ADJUSTMENT_IN: { label: 'Adjustment in', icon: 'tune', tone: 'success' },
  ADJUSTMENT_OUT: { label: 'Adjustment out', icon: 'tune', tone: 'danger' },
  TRANSFER_IN: { label: 'Transferred in', icon: 'move_to_inbox', tone: 'success' },
  TRANSFER_OUT: { label: 'Transferred out', icon: 'outbox', tone: 'danger' },
  DAMAGE: { label: 'Damaged', icon: 'heart_broken', tone: 'danger' },
  LOSS: { label: 'Lost', icon: 'search_off', tone: 'danger' },
  EXPIRED: { label: 'Expired', icon: 'event_busy', tone: 'warning' },
  COUNT: { label: 'Stock count', icon: 'fact_check', tone: 'neutral' },
  PRODUCTION_IN: { label: 'Produced', icon: 'precision_manufacturing', tone: 'success' },
  PRODUCTION_OUT: { label: 'Used in production', icon: 'precision_manufacturing', tone: 'danger' },
}

export function stockHistoryView(options: StockHistoryOptions): HTMLElement {
  const { variantId, onBack } = options
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'

  const root = h('div', { class: 'flex w-full min-w-0 flex-col' })
  const headerSlot = h('div', { class: 'border-b border-border p-3' })
  const listSlot = h('div', { class: 'p-3' })
  const footerSlot = h('div', { class: 'border-t border-border p-3' })

  let movements: StockMovementRow[] = []
  let cursor: string | null = null
  let loading = false
  let current: StockRow | null = null
  // The ledger is read for the branch in the switcher: a variant's history in
  // one branch should not be muddied by movements in another. Resolved once.
  let branchWarehouseIds: string[] = []

  mount(listSlot, h('div', { class: 'flex justify-center p-8' }, spinner()))

  function scopeArgs(): { warehouseIds?: string[] } {
    return branchWarehouseIds.length > 0 ? { warehouseIds: branchWarehouseIds } : {}
  }

  async function resolveScope(): Promise<void> {
    const branchId = salesFloor()?.branchId
    if (!branchId) return
    try {
      branchWarehouseIds = (await repos.stock.listWarehouses(branchId)).map((w) => w.id)
    } catch {
      branchWarehouseIds = []
    }
  }

  async function load(): Promise<void> {
    try {
      await resolveScope()
      const page = await repos.stock.history(variantId, { limit: 50, ...scopeArgs() })
      movements = page.items
      cursor = page.nextCursor
      renderHeader()
      renderList()
    } catch (error) {
      mount(
        listSlot,
        emptyState('History could not be loaded', {
          description: translateError(error).message,
          iconName: 'error',
        })
      )
    } finally {
      renderFooter()
    }
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loading) return
    loading = true
    try {
      const page = await repos.stock.history(variantId, { limit: 50, cursor, ...scopeArgs() })
      movements = [...movements, ...page.items]
      cursor = page.nextCursor
      renderList()
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      loading = false
      renderFooter()
    }
  }

  /**
   * The current row is fetched separately because the ledger is ordered
   * newest-first: the top movement's `after` is the balance now, but a variant
   * may have moved between warehouses, in which case the newest movement's
   * warehouse is the right one to show.
   */
  async function loadCurrent(): Promise<void> {
    try {
      const page = await repos.stock.list({ limit: 1, search: '' })
      const found = page.items.find((row) => row.variantId === variantId) ?? null
      if (found) {
        current = found
        renderHeader()
      }
    } catch {
      // The header keeps the ledger's own figures if this fails.
    }
  }

  function renderHeader(): void {
    const latest = movements[0]
    const productName = latest?.productName ?? current?.productName ?? 'Stock history'
    const variantName = latest?.variantName ?? current?.variantName ?? null

    mount(
      headerSlot,
      h(
        'div',
        { class: 'flex items-start gap-2' },
        iconButton('arrow_back', 'Back to stock', { variant: 'ghost', onClick: onBack }),
        h(
          'div',
          { class: 'min-w-0 flex-1' },
          h('h1', { class: 'truncate text-lg font-semibold text-content', text: productName }),
          h('p', {
            class: 'text-xs text-content-muted',
            text: [
              variantName,
              current ? `${formatQty(current.quantity)} on hand` : null,
              current ? `worth ${formatMoney(current.stockValue, { currency })}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
          })
        ),
        current?.isOut
          ? badge('Out', { tone: 'danger' })
          : current?.isLow
            ? badge('Low', { tone: 'warning' })
            : null
      )
    )
  }

  function renderList(): void {
    if (movements.length === 0) {
      mount(
        listSlot,
        emptyState('No movements yet', {
          description: 'Stock received, sold, written off or transferred shows up here.',
          iconName: 'history',
        })
      )
      return
    }

    mount(
      listSlot,
      card(
        h(
          'div',
          { class: 'divide-y divide-border' },
          ...movements.map((row) => movementRow(row))
        )
      )
    )
  }

  function movementRow(row: StockMovementRow): HTMLElement {
    const meta = TYPE_LABELS[row.type] ?? {
      label: row.type.replace(/_/g, ' ').toLowerCase(),
      icon: 'sync_alt',
      tone: 'neutral' as const,
    }
    const when = new Date(row.createdAt)

    return h(
      'div',
      { class: 'flex items-start gap-3 p-3' },
      h('span', {
        class:
          'material-symbols-rounded mt-0.5 shrink-0 ' +
          (row.delta > 0 ? 'text-success' : 'text-danger'),
        'aria-hidden': 'true',
        text: meta.icon,
      }),
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h(
          'div',
          { class: 'flex flex-wrap items-baseline gap-x-2' },
          h('p', { class: 'text-sm font-medium text-content', text: meta.label }),
          h('span', {
            class: `text-sm font-semibold tabular-nums ${row.delta > 0 ? 'text-success' : 'text-danger'}`,
            text: `${row.delta > 0 ? '+' : '−'}${formatQty(Math.abs(row.delta) as typeof row.delta)}`,
          })
        ),
        // The arithmetic, spelled out: this is what makes the number
        // explainable rather than merely reportable.
        h('p', {
          class: 'mt-0.5 text-xs text-content-muted tabular-nums',
          text: `${formatQty(row.beforeQuantity)} → ${formatQty(row.afterQuantity)} · ${row.warehouseName}`,
        }),
        h(
          'p',
          { class: 'mt-0.5 text-xs text-content-subtle' },
          [
            when.toLocaleString(undefined, {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            }),
            row.note,
          ]
            .filter(Boolean)
            .join(' · ')
        )
      ),
      h('span', {
        class: 'shrink-0 text-xs text-content-subtle tabular-nums',
        text: formatMoney(row.unitCost, { currency }),
      })
    )
  }

  function renderFooter(): void {
    mount(
      footerSlot,
      h(
        'div',
        { class: 'flex items-center justify-between gap-3' },
        h('p', { class: 'text-xs text-content-subtle', text: `${movements.length} movement${movements.length === 1 ? '' : 's'}` }),
        cursor ? button('Load older', { variant: 'outline', size: 'sm', onClick: () => void loadMore() }) : null
      )
    )
  }

  void load().then(() => void loadCurrent())

  mount(root, headerSlot, listSlot, footerSlot)
  return root
}
