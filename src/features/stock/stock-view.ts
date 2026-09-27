/**
 * Stock overview (Phase 3, spec §12).
 *
 * The screen answers one question first — "what have I got, and what is it
 * worth?" — and offers the four things a shopkeeper does about it: receive,
 * write off, adjust, move between warehouses. The ledger is one tap away,
 * because a number nobody can explain is a number nobody trusts.
 *
 * Designed against a counter, not a desk: the summary is readable at a glance,
 * rows are tappable, and the destructive actions are behind a confirmation
 * that states the resulting quantity before it happens.
 */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { card, emptyState } from '../../components/ui/card'
import { input, select } from '../../components/ui/input'
import { dataTable } from '../../components/ui/table'
import { exportToolbar, sortReportRows } from '../../components/ui/table-tools'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization } from '../../app/state/session'
import { refreshStockAlerts } from '../../app/state/stock-alerts'
import { formatMoney, minor as minorOf } from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { ReportCell, ReportColumn, StockRow, WarehouseOption } from '../../shared/repositories/contracts'
import {
  openStockDialog,
  type StockDialogMode,
} from './stock-dialog'
import { can } from '../../app/state/session'

type Filter = 'all' | 'low' | 'out'

/** The stock book's columns — screen, CSV, picture and printout alike (§23). */
const STOCK_COLUMNS: readonly ReportColumn[] = [
  { key: 'product', label: 'Product', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'warehouse', label: 'Location', type: 'text' },
  { key: 'qty', label: 'On hand', type: 'qty', align: 'right' },
  { key: 'reorder', label: 'Reorder at', type: 'qty', align: 'right' },
  { key: 'cost', label: 'Avg cost', type: 'money', align: 'right' },
  { key: 'value', label: 'Value', type: 'money', align: 'right' },
  { key: 'status', label: 'Status', type: 'status' },
  { key: 'updated', label: 'Last moved', type: 'date' },
]

export interface StockViewOptions {
  onNavigate?: (path: string) => void
}

export function stockView(options: StockViewOptions = {}): HTMLElement {
  const { onNavigate } = options
  const currency = activeOrganization()?.currency ?? 'BDT'

  const repos = getRepositories()

  // ── State ───────────────────────────────────────────────────────────────
  let filter: Filter = 'all'
  let search = ''
  let warehouseId = ''
  let cursor: string | null = null
  let rows: StockRow[] = []
  let warehouses: WarehouseOption[] = []
  let loading = false
  let sortKey: string | undefined
  let sortDir: 'asc' | 'desc' = 'desc'

  /** One stock line as the table (and every export) sees it. */
  function toReportRow(row: StockRow): Record<string, ReportCell> {
    return {
      variantId: row.variantId,
      product: row.variantName ? `${row.productName} — ${row.variantName}` : row.productName,
      sku: row.sku,
      warehouse: row.warehouseName,
      qty: Number(row.quantity) / 1000,
      reorder: row.trackStock ? Number(row.reorderPoint) / 1000 : null,
      cost: Number(row.avgUnitCost),
      value: Number(row.stockValue),
      status: row.isOut ? 'out' : row.isLow ? 'low' : row.trackStock ? 'ok' : 'untracked',
      updated: row.updatedAt,
    }
  }

  function visibleRows(): Record<string, ReportCell>[] {
    const mapped = rows.map(toReportRow)
    return sortKey ? sortReportRows(STOCK_COLUMNS, mapped, sortKey, sortDir) : mapped
  }

  const root = h('div', { class: 'flex w-full min-w-0 flex-col' })

  const summarySlot = h('div', { class: 'grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 xl:grid-cols-6' })
  const listSlot = h('div', { class: 'px-3 pb-6' })
  const footerSlot = h('div', { class: 'border-t border-border p-3' })

  // ── Toolbar ─────────────────────────────────────────────────────────────
  const searchField = input({
    type: 'search',
    placeholder: 'Search product, variant or SKU…',
    autocomplete: 'off',
    onInput: (value) => {
      search = value
      void reload()
    },
  })

  const filterTabs = h('div', { class: 'flex gap-1 rounded-lg bg-surface-muted p-1' })
  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'low', label: 'Low' },
    { key: 'out', label: 'Out' },
  ]

  const warehouseSelect = select({
    id: 'stock-warehouse',
    options: [],
    placeholder: 'All stock locations',
    onChange: (value) => {
      warehouseId = value
      void reload()
    },
  })

  const inButton = button('Stock in', { variant: 'primary', icon: 'add_box', onClick: () => open('in') })
  const outButton = button('Stock out', { variant: 'outline', icon: 'remove_circle', onClick: () => open('out') })
  const transferButton = button('Transfer', { variant: 'outline', icon: 'swap_horiz', onClick: () => open('transfer') })
  const adjustButton = button('Adjust', { variant: 'outline', icon: 'tune', onClick: () => open('adjust') })

  function open(mode: StockDialogMode): void {
    openStockDialog({
      mode,
      currency,
      warehouses,
      onDone: (message) => {
        toastSuccess(message)
        void refreshStockAlerts()
        void reload()
        void loadSummary()
      },
    })
  }

  function renderFilterTabs(): void {
    mount(
      filterTabs,
      ...FILTERS.map((entry) =>
        h('button', {
          type: 'button',
          class:
            'min-h-[40px] flex-1 rounded-md px-3 text-sm font-medium transition-colors ' +
            (filter === entry.key
              ? 'bg-surface text-content shadow-sm'
              : 'text-content-muted hover:text-content'),
          text: entry.label,
          'aria-pressed': String(filter === entry.key),
          onclick: () => {
            filter = entry.key
            renderFilterTabs()
            void reload()
          },
        })
      )
    )
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  async function loadSummary(): Promise<void> {
    try {
      const summary = await repos.stock.summary()
      mount(
        summarySlot,
        statCard('Stock value', formatMoney(summary.stockValue, { currency }), 'payments'),
        statCard('Items in stock', String(summary.variantsInStock), 'inventory_2'),
        statCard('Low stock', String(summary.lowStock), 'trending_down', summary.lowStock > 0 ? 'warning' : undefined),
        statCard('Out of stock', String(summary.outOfStock), 'production_quantity_limits', summary.outOfStock > 0 ? 'danger' : undefined),
        statCard('Movements today', String(summary.movementsToday), 'sync_alt'),
        statCard('Stock locations', String(summary.warehouses), 'warehouse')
      )
    } catch (error) {
      mount(
        summarySlot,
        h('p', { class: 'col-span-full text-sm text-content-muted', text: translateError(error).message })
      )
    }
  }

  function statCard(
    label: string,
    value: string,
    iconName: string,
    tone?: 'warning' | 'danger'
  ): HTMLElement {
    const toneClass =
      tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-content'
    return card(
      h(
        'div',
        { class: 'flex items-start justify-between gap-2' },
        h('p', { class: 'text-xs font-medium text-content-muted', text: label }),
        h('span', {
          class: 'material-symbols-rounded text-content-subtle',
          'aria-hidden': 'true',
          text: iconName,
        })
      ),
      h('p', { class: `mt-1 text-xl font-semibold tabular-nums ${toneClass}`, text: value })
    )
  }

  // ── List ────────────────────────────────────────────────────────────────
  async function reload(): Promise<void> {
    if (loading) return
    loading = true
    cursor = null
    mount(listSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    try {
      const page = await repos.stock.list({
        limit: 50,
        filter,
        ...(search.trim() ? { search } : {}),
        ...(warehouseId ? { warehouseId } : {}),
      })
      rows = page.items
      cursor = page.nextCursor
      renderList()
    } catch (error) {
      mount(listSlot, emptyState('Stock could not be loaded', { description: translateError(error).message, iconName: 'error' }))
    } finally {
      loading = false
      renderFooter()
    }
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loading) return
    loading = true
    try {
      const page = await repos.stock.list({
        limit: 50,
        cursor,
        filter,
        ...(search.trim() ? { search } : {}),
        ...(warehouseId ? { warehouseId } : {}),
      })
      rows = [...rows, ...page.items]
      cursor = page.nextCursor
      renderList()
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      loading = false
      renderFooter()
    }
  }

  function renderList(): void {
    if (rows.length === 0) {
      mount(
        listSlot,
        emptyState(
          filter === 'low' ? 'Nothing is running low' : filter === 'out' ? 'Nothing is out of stock' : 'No stock yet',
          {
            description:
              filter === 'all'
                ? 'Receive your first delivery with Stock in, or add a product and record its opening quantity.'
                : 'Good news. This list fills itself when something drops to its reorder point.',
            iconName: filter === 'all' ? 'inventory' : 'check_circle',
            ...(filter === 'all' && can('inventory.stock_in') ? { action: button('Stock in', { variant: 'primary', icon: 'add_box', onClick: () => open('in') }) } : {}),
          }
        )
      )
      return
    }

    const visible = visibleRows()
    const totalValue = visible.reduce((sum, row) => sum + Number(row['value'] ?? 0), 0)

    const toolbar = exportToolbar({
      title: 'Stock',
      filename: 'stock',
      columns: STOCK_COLUMNS,
      currency,
      rows: () => visibleRows(),
      subtitle: () =>
        `${visible.length} line${visible.length === 1 ? '' : 's'} · ` +
        `${formatMoney(minorOf(totalValue), { currency, digits: 'latin', convert: false })} on the shelves`,
      footerNote: activeOrganization()?.name ?? 'Mekholi POS',
      onNotice: (message, bad) => (bad ? toastError(message) : toastSuccess(message)),
    })

    mount(
      listSlot,
      h(
        'div',
        { class: 'flex flex-col gap-3' },
        h('div', { class: 'flex justify-end' }, toolbar),
        h(
          'div',
          { class: 'overflow-hidden rounded-xl border border-border bg-surface' },
          dataTable({
            columns: STOCK_COLUMNS,
            rows: visible,
            totals: { value: totalValue },
            currency,
            sort: sortKey,
            dir: sortDir,
            onSort: (key) => {
              if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
              else {
                sortKey = key
                const type = STOCK_COLUMNS.find((c) => c.key === key)?.type
                // Quantities and money open big-first; words open A-first.
                sortDir = type === 'money' || type === 'qty' ? 'desc' : 'asc'
              }
              renderList()
            },
            // The row is the way into the ledger: "why is this 37?" is the
            // question a stock number always provokes.
            onRowClick: (reportRow) => onNavigate?.(`/stock/history/${String(reportRow['variantId'])}`),
            pageSize: 50,
          })
        )
      )
    )
  }

  function renderFooter(): void {
    mount(
      footerSlot,
      h(
        'div',
        { class: 'flex items-center justify-between gap-3' },
        h('p', {
          class: 'text-xs text-content-subtle',
          text: `${rows.length} line${rows.length === 1 ? '' : 's'}${cursor ? ' · more available' : ''}`,
        }),
        cursor
          ? button('Load more', { variant: 'outline', onClick: () => void loadMore() })
          : null
      )
    )
  }

  // ── Assembly ────────────────────────────────────────────────────────────
  renderFilterTabs()

  const toolbar = h(
    'div',
    { class: 'space-y-3 border-b border-border p-3' },
    h('div', { class: 'flex flex-col gap-2 sm:flex-row sm:items-center' }, searchField, warehouseSelect),
    h('div', { class: 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' }, filterTabs,
      h(
        'div',
        { class: 'flex flex-wrap gap-2' },
        can('inventory.stock_in') ? inButton : null,
        can('inventory.stock_out') ? outButton : null,
        can('inventory.adjust') ? adjustButton : null,
        can('inventory.transfer') ? transferButton : null
      )
    )
  )

  mount(
    root,
    h('div', { class: 'border-b border-border px-3 pt-3' },
      h('h1', { class: 'text-lg font-semibold text-content', text: 'Stock' })
    ),
    summarySlot,
    toolbar,
    listSlot,
    footerSlot
  )

  void (async () => {
    try {
      warehouses = await repos.stock.listWarehouses()
      mount(
        warehouseSelect,
        h('option', { value: '', text: 'All stock locations' }),
        ...warehouses.map((w) => h('option', { value: w.id, text: w.name }))
      )
      // A single-warehouse shop does not need the choice — hide it and keep
      // the toolbar to one line.
      if (warehouses.length <= 1) warehouseSelect.classList.add('hidden')
    } catch {
      warehouses = []
    }
    await loadSummary()
    await reload()
  })()

  return root
}
