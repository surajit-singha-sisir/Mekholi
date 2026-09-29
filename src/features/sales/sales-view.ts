/**
 * Sales list and sale detail, with returns (Phase 2 §19/§54 surface, finished
 * in Phase 4 because returns need it).
 *
 * The list is what a shopkeeper opens when a customer walks back in with a
 * receipt: search by invoice number or name, open the sale, refund a line — or
 * part of a line — either back to the method it was paid with or onto the
 * customer's store credit.
 *
 * Two things the screen deliberately refuses to fake:
 *
 *   The "already returned" count is shown against each line. Handing back an
 *   item twice is the mistake a refund counter makes, and the database would
 *   refuse it anyway — so the number is on screen before the attempt, not in an
 *   error message after it.
 *
 *   The refund buttons are gated on `sales.refund`. A cashier who may sell is
 *   not thereby allowed to give money back, which is a different trust.
 */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { badge, card, emptyState } from '../../components/ui/card'
import { dataTable } from '../../components/ui/table'
import { exportToolbar, sortReportRows } from '../../components/ui/table-tools'
import { input, select, field, textarea } from '../../components/ui/input'
import { modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization, can } from '../../app/state/session'
import { salesFloor } from '../../app/state/sales-floor'
import { pluginSaleTabsHost } from '../../app/plugin-slots'
import type { PluginRegistry } from '../../shared/registry/plugin-registry'
import { formatMoney, formatQty, milliToNumber, minor, minorToNumber, type Milli, type Minor } from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { ReportCell, ReportColumn, SaleDetail, SalesListRow } from '../../shared/repositories/contracts'
import type { PaymentMethod } from '../../shared/types/records'
import { buildReceipt, printReceipt, saveReceiptFile, showReceipt, type ReceiptData } from '../pos'
import { saleDue } from './sale-due'

export interface SalesViewOptions {
  /** The plugin host: tabs registered by enabled plugins appear on a sale. */
  registry: PluginRegistry
  onNavigate?: (path: string) => void
}

const STATUS_TONES: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  COMPLETED: 'success',
  PARTIALLY_PAID: 'warning',
  REFUNDED: 'danger',
  PARTIALLY_REFUNDED: 'warning',
  CANCELLED: 'neutral',
  HELD: 'neutral',
  DRAFT: 'neutral',
}

export function salesView(options: SalesViewOptions): HTMLElement {
  const { registry } = options
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'
  /** Invoices already fetched this session, keyed by sale id. */
  const receiptCache = new Map<string, ReceiptData>()

  let search = ''
  let status = ''
  let rows: SalesListRow[] = []
  let cursor: string | null = null
  let loading = false
  let sortKey: string | undefined
  let sortDir: 'asc' | 'desc' = 'desc'

  const root = h('div', { class: 'flex w-full min-w-0 flex-col' })
  const summarySlot = h('div', { class: 'grid grid-cols-2 gap-2 p-3 sm:grid-cols-4' })
  const listSlot = h('div', { class: 'p-3' })
  const footerSlot = h('div', { class: 'border-t border-border p-3' })

  // The branch column exists only while the Branch plugin does — a
  // one-branch shop should not read "Main Store" down a whole column.
  const SALES_COLUMNS: readonly ReportColumn[] = [
    { key: 'invoice', label: 'Invoice', type: 'text' },
    { key: 'customer', label: 'Customer', type: 'text' },
    ...(registry.loadedIds.includes('branch')
      ? ([{ key: 'branch', label: 'Branch', type: 'text' }] as ReportColumn[])
      : []),
    { key: 'when', label: 'When', type: 'date' },
    { key: 'total', label: 'Total', type: 'money', align: 'right' },
    { key: 'paid', label: 'Paid', type: 'money', align: 'right' },
    { key: 'due', label: 'Due', type: 'money', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ]

  function toReportRow(row: SalesListRow): Record<string, ReportCell> {
    // The same rule as the due book: a cancelled or fully refunded sale owes
    // nothing, so it never shows a due here either (see ./sale-due).
    const due = saleDue(row.status, Number(row.total), Number(row.paidTotal))
    return {
      id: row.id,
      invoice: row.invoiceNo,
      customer: row.customerName ?? 'Walk-in',
      branch: row.branchName,
      when: row.createdAt,
      total: Number(row.total),
      paid: Number(row.paidTotal),
      due,
      status: row.status,
    }
  }

  function visibleRows(): Record<string, ReportCell>[] {
    const mapped = rows.map(toReportRow)
    return sortKey ? sortReportRows(SALES_COLUMNS, mapped, sortKey, sortDir) : mapped
  }

  function renderSummary(): void {
    const sold = rows.reduce((sum, row) => sum + Number(row.total), 0)
    const collected = rows.reduce((sum, row) => sum + Number(row.paidTotal), 0)
    const outstanding = rows.reduce(
      (sum, row) => sum + saleDue(row.status, Number(row.total), Number(row.paidTotal)),
      0
    )
    const stat = (label: string, value: string, iconName: string, warn?: boolean): HTMLElement =>
      card(
        h(
          'div',
          { class: 'flex items-start justify-between gap-2' },
          h('p', { class: 'text-xs font-medium text-content-muted', text: label }),
          h('span', { class: 'material-symbols-rounded text-content-subtle', 'aria-hidden': 'true', text: iconName })
        ),
        h('p', {
          class: `mt-1 text-xl font-semibold tabular-nums ${warn ? 'text-warning' : 'text-content'}`,
          text: value,
        })
      )
    mount(
      summarySlot,
      stat('Sales shown', String(rows.length), 'receipt_long'),
      stat('Sold', formatMoney(minor(sold), { currency }), 'payments'),
      stat('Collected', formatMoney(minor(collected), { currency }), 'account_balance_wallet'),
      stat('Due', formatMoney(minor(outstanding), { currency }), 'schedule', outstanding > 0)
    )
  }

  const searchField = input({
    type: 'search',
    placeholder: 'Invoice number or customer…',
    autocomplete: 'off',
    onInput: (value) => {
      search = value
      void reload()
    },
  })

  const statusSelect = select({
    id: 'sales-status',
    options: [
      { value: '', label: 'All sales' },
      { value: 'COMPLETED', label: 'Completed' },
      { value: 'PARTIALLY_PAID', label: 'Part paid' },
      { value: 'PARTIALLY_REFUNDED', label: 'Part refunded' },
      { value: 'REFUNDED', label: 'Refunded' },
      { value: 'HELD', label: 'Held' },
    ],
    value: '',
    onChange: (value) => {
      status = value
      void reload()
    },
  })

  async function reload(): Promise<void> {
    if (loading) return
    loading = true
    cursor = null
    mount(listSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    try {
      const page = await repos.sales.listAll({
        limit: 30,
        // Only this branch's sales — the Sales screen follows the switcher.
        branchId: salesFloor()?.branchId ?? null,
        ...(search.trim() ? { search } : {}),
        ...(status ? { status } : {}),
      })
      rows = page.items
      cursor = page.nextCursor
      render()
    } catch (error) {
      mount(
        listSlot,
        emptyState('Sales could not be loaded', {
          description: translateError(error).message,
          iconName: 'error',
        })
      )
    } finally {
      loading = false
      renderFooter()
    }
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loading) return
    loading = true
    try {
      const page = await repos.sales.listAll({
        limit: 30,
        cursor,
        branchId: salesFloor()?.branchId ?? null,
        ...(search.trim() ? { search } : {}),
        ...(status ? { status } : {}),
      })
      rows = [...rows, ...page.items]
      cursor = page.nextCursor
      render()
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      loading = false
      renderFooter()
    }
  }

  function render(): void {
    renderSummary()
    if (rows.length === 0) {
      mount(
        listSlot,
        emptyState('No sales here', {
          description: 'Sales appear the moment the POS completes one. Try a different search or filter.',
          iconName: 'receipt_long',
          ...(can('sales.create')
            ? { action: button('Open the POS', { variant: 'primary', icon: 'point_of_sale', onClick: () => options.onNavigate?.('/pos') }) }
            : {}),
        })
      )
      return
    }

    const visible = visibleRows()
    const soldTotal = visible.reduce((sum, row) => sum + Number(row['total'] ?? 0), 0)
    const paidTotal = visible.reduce((sum, row) => sum + Number(row['paid'] ?? 0), 0)
    const dueTotal = visible.reduce((sum, row) => sum + Number(row['due'] ?? 0), 0)

    const toolbar = exportToolbar({
      title: 'Sales',
      filename: 'sales',
      columns: SALES_COLUMNS,
      currency,
      rows: () => visibleRows(),
      subtitle: () =>
        `${visible.length} sale${visible.length === 1 ? '' : 's'} · ` +
        `${formatMoney(minor(soldTotal), { currency, digits: 'latin', convert: false })} sold`,
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
            columns: SALES_COLUMNS,
            rows: visible,
            totals: { total: soldTotal, paid: paidTotal, due: dueTotal },
            currency,
            sort: sortKey,
            dir: sortDir,
            onSort: (key) => {
              if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
              else {
                sortKey = key
                const type = SALES_COLUMNS.find((c) => c.key === key)?.type
                sortDir = type === 'money' || type === 'date' ? 'desc' : 'asc'
              }
              render()
            },
            onRowClick: (reportRow) => void openDetail(String(reportRow['id'])),
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
          text: `${rows.length} sale${rows.length === 1 ? '' : 's'}${cursor ? ' · more available' : ''}`,
        }),
        cursor ? button('Load more', { variant: 'outline', onClick: () => void loadMore() }) : null
      )
    )
  }

  /** Detail opens as a modal: a customer is standing at the counter. */
  async function openDetail(saleId: string): Promise<void> {
    const dialog = modal({
      title: 'Sale',
      size: 'lg',
      iconName: 'receipt_long',
      footer: [],
    })
    mount(dialog.body, h('div', { class: 'flex justify-center p-6' }, spinner()))

    try {
      const detail = await repos.sales.detail(saleId)
      if (!detail) {
        mount(dialog.body, emptyState('Sale not found', { iconName: 'search_off' }))
        return
      }
      renderDetail(dialog, detail)
    } catch (error) {
      mount(dialog.body, emptyState('Could not open the sale', { description: translateError(error).message, iconName: 'error' }))
    }
  }

  /**
   * The invoice, as the customer would receive it.
   *
   * Built from the stored sale rather than from the rows on screen, and by
   * the same `buildReceipt` the till uses, so a reprint months later is the
   * document that came out of the printer at the time — not a re-rendering of
   * it with today's shop name and today's rounding. Fetched once per dialog
   * and remembered: four buttons must not mean four round trips.
   */
  async function invoiceFor(saleId: string): Promise<ReceiptData | null> {
    const cached = receiptCache.get(saleId)
    if (cached) return cached
    try {
      const row = await repos.sales.get(saleId)
      if (!row) {
        toastError('That sale could not be loaded.')
        return null
      }
      const data = buildReceipt(row, activeOrganization()?.name ?? 'Mekholi')
      receiptCache.set(saleId, data)
      return data
    } catch (error) {
      toastError(translateError(error).message)
      return null
    }
  }

  /**
   * Preview, print, image, PDF — the four things a shop does with an invoice
   * after the sale.
   *
   * They are here rather than only on the till because the request always
   * arrives later: the customer wants it emailed, the accountant wants the
   * PDF, the paper jammed and it needs reprinting. Every one of them produces
   * the identical document.
   */
  function invoiceActions(saleId: string): HTMLElement {
    const run = (action: (data: ReceiptData) => void | Promise<void>) => async (): Promise<void> => {
      const data = await invoiceFor(saleId)
      if (data) await action(data)
    }

    return h('div', { class: 'flex flex-wrap gap-2' },
      button('Preview invoice', {
        variant: 'outline',
        size: 'sm',
        icon: 'receipt_long',
        onClick: () => void run((data) => void showReceipt(data))(),
      }),
      button('Print', {
        variant: 'outline',
        size: 'sm',
        icon: 'print',
        onClick: () => void run((data) => printReceipt(data))(),
      }),
      button('Image', {
        variant: 'outline',
        size: 'sm',
        icon: 'image',
        onClick: () => void run((data) => saveReceiptFile(data, 'png'))(),
      }),
      button('PDF', {
        variant: 'outline',
        size: 'sm',
        icon: 'picture_as_pdf',
        onClick: () => void run((data) => saveReceiptFile(data, 'pdf'))(),
      })
    )
  }

  function renderDetail(dialog: ReturnType<typeof modal>, detail: SaleDetail): void {
    const { sale, items, payments, returns } = detail
    const refundable = can('sales.refund') && ['COMPLETED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'].includes(sale.status)

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        h(
          'div',
          { class: 'flex flex-wrap items-center justify-between gap-3' },
          h(
            'div',
            null,
            h('p', { class: 'text-lg font-semibold tabular-nums text-content', text: sale.invoiceNo }),
            h('p', {
              class: 'text-xs text-content-muted',
              // The branch name belongs to the Branch plugin: a one-branch
              // shop should not read "Main Store" on every line of its life.
              text: [
                sale.customerName ?? 'Walk-in customer',
                registry.loadedIds.includes('branch') ? (sale.branchName ?? '') : '',
                formatWhen(sale.createdAt),
              ]
                .filter(Boolean)
                .join(' · '),
            })
          ),
          badge(sale.status.replace(/_/g, ' ').toLowerCase(), { tone: STATUS_TONES[sale.status] ?? 'neutral' })
        ),

        invoiceActions(sale.id),

        card(
          h(
            'div',
            { class: 'divide-y divide-border' },
            ...items.map((item) => {
              const remaining = milliToNumber(item.quantity) - milliToNumber(item.returnedQty)
              return h(
                'div',
                { class: 'flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0' },
                h(
                  'div',
                  { class: 'min-w-0' },
                  h('p', { class: 'truncate text-sm text-content', text: item.productName }),
                  h('p', {
                    class: 'text-xs text-content-muted tabular-nums',
                    text: [
                      item.variantName,
                      `${formatQty(item.quantity)} × ${formatMoney(item.unitPrice, { currency })}`,
                      // The number that stops a double refund before it happens.
                      milliToNumber(item.returnedQty) > 0 ? `${formatQty(item.returnedQty)} already returned` : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  })
                ),
                h(
                  'div',
                  { class: 'shrink-0 text-right' },
                  h('p', { class: 'text-sm tabular-nums text-content', text: formatMoney(item.lineTotal, { currency }) }),
                  refundable && remaining > 0
                    ? h('button', {
                        type: 'button',
                        class: 'mt-1 text-xs font-medium text-primary hover:underline',
                        text: 'Refund',
                        onclick: () => openRefund(dialog, detail, item.id),
                      })
                    : null
                )
              )
            })
          )
        ),

        h(
          'div',
          { class: 'grid gap-3 sm:grid-cols-2' },
          card(
            h('p', { class: 'text-xs font-medium text-content-muted', text: 'Paid' }),
            ...payments.map((payment) =>
              h(
                'p',
                { class: 'mt-1 flex justify-between text-sm' },
                h('span', { text: payment.methodName ?? 'Payment' }),
                h('span', { class: 'tabular-nums', text: formatMoney(payment.amount, { currency }) })
              )
            ),
            h(
              'p',
              { class: 'mt-2 flex justify-between border-t border-border pt-2 text-sm font-semibold' },
              h('span', { text: 'Total' }),
              h('span', { class: 'tabular-nums', text: formatMoney(sale.total, { currency }) })
            )
          ),
          returns.length > 0
            ? card(
                h('p', { class: 'text-xs font-medium text-content-muted', text: 'Returns' }),
                ...returns.map((entry) =>
                  h(
                    'div',
                    { class: 'mt-2 text-sm' },
                    h(
                      'div',
                      { class: 'flex items-center justify-between gap-2' },
                      h('span', { class: 'tabular-nums text-content', text: entry.returnNo }),
                      h('span', {
                        class: 'tabular-nums text-danger',
                        text: `−${formatMoney(entry.refundTotal, { currency })}`,
                      })
                    ),
                    h('p', {
                      class: 'text-xs text-content-muted',
                      text: [entry.reason, entry.restock ? 'restocked' : 'not restocked'].filter(Boolean).join(' · '),
                    })
                  )
                )
              )
            : card(
                h('p', { class: 'text-xs font-medium text-content-muted', text: 'Returns' }),
                h('p', { class: 'mt-1 text-sm text-content-subtle', text: 'Nothing has been returned on this sale.' })
              )
        )
      ),
      // Plugin tabs last: they decorate a finished sale, and a shop with no
      // plugins sees exactly the screen it saw before any were installed.
      pluginSaleTabsHost(registry, {
        organizationId: activeOrganization()?.organization_id ?? '',
        branchId: salesFloor()?.branchId ?? null,
        currency,
        saleId: sale.id,
        customerId: sale.customerId,
        total: minorToNumber(sale.total),
      })
    )
  }

  // ── Refund ──────────────────────────────────────────────────────────────

  async function openRefund(
    parent: ReturnType<typeof modal>,
    detail: SaleDetail,
    saleItemId: string
  ): Promise<void> {
    const item = detail.items.find((entry) => entry.id === saleItemId)
    if (!item) return
    const remaining = milliToNumber(item.quantity) - milliToNumber(item.returnedQty)
    const currency = activeOrganization()?.currency ?? 'BDT'

    const methods = await loadPaymentMethods()
    const cashMethod = methods.find((method) => method.is_cash) ?? methods[0]

    const qtyInput = input({
      id: 'refund-qty',
      type: 'text',
      inputmode: 'decimal',
      value: String(remaining),
      autocomplete: 'off',
    })
    const reasonInput = textarea({ id: 'refund-reason', rows: 2, placeholder: 'Why is it coming back? (optional)' })
    // Store credit is only offered when the sale has a customer to hold it —
    // the database refuses otherwise, so offering it would be a lie.
    const creditOption = detail.sale.customerId !== null
    const targetSelect = select({
      id: 'refund-target',
      options: [
        { value: 'method', label: cashMethod ? `Back to ${cashMethod.name}` : 'Back to the original method' },
        ...(creditOption
          ? [{ value: 'credit', label: `Store credit for ${detail.sale.customerName ?? 'the customer'}` }]
          : []),
      ],
      value: 'method',
    })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })

    const submit = button('Refund', { variant: 'danger', fullWidth: true, size: 'lg' })
    const dialog = modal({
      title: 'Refund an item',
      subtitle: `${item.productName} · ${formatQty(item.quantity)} sold, ${formatQty(item.returnedQty)} already returned`,
      iconName: 'assignment_return',
      size: 'sm',
      footer: [h('div', { class: 'w-full' }, submit)],
    })

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        field('Quantity to refund', qtyInput, {
          required: true,
        }),
        field('Refund to', targetSelect),
        field('Reason', reasonInput),
        errorSlot,
        h('p', {
          class: 'text-xs text-content-subtle',
          text: 'Stock returns to the shelf and the sale keeps a permanent record of the return.',
        })
      )
    )

    submit.addEventListener('click', () => {
      void (async () => {
        errorSlot.classList.add('hidden')
        const qty = Number(qtyInput.value)
        if (!Number.isFinite(qty) || qty <= 0) {
          errorSlot.textContent = 'Enter a quantity greater than zero.'
          errorSlot.classList.remove('hidden')
          return
        }
        if (qty > remaining) {
          errorSlot.textContent = `Only ${remaining} can still be returned on this line.`
          errorSlot.classList.remove('hidden')
          return
        }

        submit.disabled = true
        try {
          const amount = (minorToNumber(item.lineTotal) * (qty / milliToNumber(item.quantity))) as Minor
          const result =
            targetSelect.value === 'credit'
              ? await repos.returns.refundToCredit({
                  saleId: detail.sale.id,
                  lines: [{ saleItemId, qty: (qty * 1000) as Milli }],
                  reason: reasonInput.value.trim() || null,
                })
              : await repos.returns.refund({
                  saleId: detail.sale.id,
                  lines: [{ saleItemId, qty: (qty * 1000) as Milli }],
                  payments: cashMethod
                    ? [{ methodId: cashMethod.id, amount }]
                    : [],
                  reason: reasonInput.value.trim() || null,
                })

          dialog.close()
          parent.close()
          toastSuccess(
            result.storeCredit !== undefined
              ? `Refunded ${formatMoney(result.refundTotal, { currency })} as store credit`
              : `Refunded ${formatMoney(result.refundTotal, { currency })}`
          )
          void reload()
        } catch (error) {
          errorSlot.textContent = translateError(error).message
          errorSlot.classList.remove('hidden')
        } finally {
          submit.disabled = false
        }
      })()
    })
  }

  /** Payment methods, cached for the session: they change by configuration. */
  let methodCache: PaymentMethod[] | null = null
  async function loadPaymentMethods(): Promise<PaymentMethod[]> {
    if (methodCache) return methodCache
    try {
      methodCache = await repos.catalog.listPaymentMethods()
    } catch {
      methodCache = []
    }
    return methodCache
  }

  const toolbar = h(
    'div',
    { class: 'space-y-3 border-b border-border p-3' },
    h('div', { class: 'flex flex-col gap-2 sm:flex-row' }, searchField, statusSelect)
  )

  mount(
    root,
    h('div', { class: 'border-b border-border px-3 pt-3 pb-3' }, h('h1', { class: 'text-lg font-semibold text-content', text: 'Sales' })),
    summarySlot,
    toolbar,
    listSlot,
    footerSlot
  )

  void reload()
  return root
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
