/**
 * Purchases: purchase orders, receiving, and paying suppliers (spec §20, §23).
 *
 * The screen is shaped around the three moments a shop actually has:
 *
 *   Raising an order — pick a supplier, add lines, save it as a draft or send
 *   it off. Nothing moves until stock arrives, which is why a DRAFT costs
 *   nothing and an ORDERED order shows up as money owed.
 *
 *   Receiving — frequently partial. A van brings 8 of the 20 sacks ordered,
 *   and the shop must be able to say so: the receive dialog starts each line at
 *   what is still outstanding, lets it be reduced, and shows the running
 *   difference. The order then reads PARTIALLY_RECEIVED with the remainder
 *   still outstanding, which is a fact about the shop, not a UI state.
 *
 *   Paying — often for several orders at once, so payment is recorded against
 *   the supplier and the server allocates it oldest-first.
 *
 * Cost is entered here and nowhere else for stock coming in. Receiving at a
 * cost above the last one moves the weighted average, which is why the dialog
 * shows the unit cost per line rather than hiding it behind the order total.
 */

import { h, mount } from '../../components/ui/h'
import { button, iconButton, spinner } from '../../components/ui/button'
import { badge, card, emptyState } from '../../components/ui/card'
import { input, field, searchInput, select } from '../../components/ui/input'
import { modal, confirm } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization, can } from '../../app/state/session'
import { salesFloor, refreshSalesFloor } from '../../app/state/sales-floor'
import {
  formatMoney,
  formatQty,
  milliToNumber,
  minorToNumber,
  minor,
  toMinor,
  milli,
  parseMilli,
  parseMinor,
  roundHalfAway,
  type Milli,
  type Minor,
} from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { SellableProduct } from '../../shared/repositories/contracts'
import type { PaymentMethod } from '../../shared/types/records'
import type { PurchaseDetail, PurchaseItemRow, PurchaseRow, SupplierRow } from '../../shared/repositories/contracts'

export interface PurchasesViewOptions {
  onNavigate?: (path: string) => void
  /** Pre-selects a supplier, set by the suppliers screen's "raise an order". */
  supplierId?: string | undefined
}

interface DraftLine {
  variantId: string
  name: string
  qty: Milli
  unitCost: Minor
}

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'PARTIALLY_RECEIVED', label: 'Part received' },
  { value: 'RECEIVED', label: 'Received' },
  { value: 'CANCELLED', label: 'Cancelled' },
]

export function purchasesView(options: PurchasesViewOptions = {}): HTMLElement {
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'

  let status = ''
  let search = ''
  let rows: PurchaseRow[] = []
  let cursor: string | null = null
  let loading = false

  const root = h('div', { class: 'flex w-full min-w-0 flex-col' })
  const listSlot = h('div', { class: 'p-3' })
  const footerSlot = h('div', { class: 'border-t border-border p-3' })

  const searchBox = searchInput('Order number or reference…', (value) => {
    search = value
    void reload()
  })

  const statusTabs = h(
    'div',
    { class: 'flex gap-1 overflow-x-auto' },
    ...STATUS_FILTERS.map((filter) =>
      h('button', {
        type: 'button',
        class:
          'min-h-[40px] shrink-0 rounded-md px-3 text-sm font-medium ' +
          (status === filter.value ? 'bg-primary text-primary-foreground' : 'text-content-muted hover:bg-surface-muted'),
        text: filter.label,
        onclick: () => {
          status = filter.value
          mount(statusTabs, ...tabButtons())
          void reload()
        },
      })
    )
  )

  function tabButtons(): HTMLElement[] {
    return STATUS_FILTERS.map((filter) =>
      h('button', {
        type: 'button',
        class:
          'min-h-[40px] shrink-0 rounded-md px-3 text-sm font-medium ' +
          (status === filter.value ? 'bg-primary text-primary-foreground' : 'text-content-muted hover:bg-surface-muted'),
        text: filter.label,
        onclick: () => {
          status = filter.value
          mount(statusTabs, ...tabButtons())
          void reload()
        },
      })
    )
  }

  async function reload(): Promise<void> {
    if (loading) return
    loading = true
    cursor = null
    mount(listSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    try {
      const page = await repos.purchases.list({
        limit: 30,
        ...(status ? { status } : {}),
        ...(search.trim() ? { search } : {}),
      })
      rows = page.items
      cursor = page.nextCursor
      render()
    } catch (error) {
      mount(listSlot, emptyState('Purchases could not be loaded', { description: translateError(error).message, iconName: 'error' }))
    } finally {
      loading = false
      renderFooter()
    }
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loading) return
    loading = true
    try {
      const page = await repos.purchases.list({ limit: 30, cursor, ...(status ? { status } : {}), ...(search.trim() ? { search } : {}) })
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
    if (rows.length === 0) {
      mount(
        listSlot,
        emptyState('No purchase orders', {
          description: 'Raise an order when you buy from a supplier. Receiving it puts the stock on the shelf and the amount on their account.',
          iconName: 'local_shipping',
          ...(can('purchases.create')
            ? { action: button('New order', { variant: 'primary', icon: 'add', onClick: () => void openEditor(null) }) }
            : {}),
        })
      )
      return
    }

    mount(
      listSlot,
      h(
        'div',
        { class: 'overflow-hidden rounded-xl border border-border bg-surface' },
        ...rows.map((row) =>
          h(
            'button',
            {
              type: 'button',
              class:
                'flex w-full min-h-[68px] items-center gap-3 border-b border-border p-3 text-left ' +
                'last:border-b-0 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              onclick: () => void openDetail(row.id),
            },
            h(
              'div',
              { class: 'min-w-0 flex-1' },
              h(
                'div',
                { class: 'flex flex-wrap items-center gap-2' },
                h('span', { class: 'font-medium tabular-nums text-content', text: row.invoiceNo }),
                badge(row.status.replace(/_/g, ' ').toLowerCase(), { tone: toneFor(row.status) })
              ),
              h('p', {
                class: 'mt-0.5 truncate text-xs text-content-muted',
                text: [row.supplierName ?? 'No supplier', new Date(row.createdAt).toLocaleDateString()].join(' · '),
              })
            ),
            h(
              'div',
              { class: 'shrink-0 text-right' },
              h('p', { class: 'text-sm font-semibold tabular-nums text-content', text: formatMoney(row.total, { currency }) }),
              minorToNumber(row.outstanding) > 0
                ? h('p', { class: 'text-xs tabular-nums text-warning', text: `${formatMoney(row.outstanding, { currency })} due` })
                : null
            )
          )
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
          text: `${rows.length} order${rows.length === 1 ? '' : 's'}${cursor ? ' · more' : ''}`,
        }),
        cursor ? button('Load more', { variant: 'outline', onClick: () => void loadMore() }) : null
      )
    )
  }

  // ── Order editor ────────────────────────────────────────────────────────

  async function openEditor(existing: PurchaseDetail | null): Promise<void> {
    const [suppliers, floor] = await Promise.all([loadSuppliers(), ensureFloor()])
    const lines: DraftLine[] = existing
      ? existing.items.map((item) => ({
          variantId: item.variantId,
          name: item.variantName ? `${item.productName} · ${item.variantName}` : item.productName,
          qty: item.quantity,
          unitCost: item.unitCost,
        }))
      : []

    const preset =
      existing?.purchase.supplierId ?? options.supplierId ?? ''
    const supplierSelect = select({
      id: 'po-supplier',
      options: [
        { value: '', label: 'No supplier (cash purchase)' },
        ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name })),
      ],
      ...(preset ? { value: preset } : {}),
    })
    const referenceInput = input({ id: 'po-reference', placeholder: 'Supplier invoice no. (optional)' })
    const expectedInput = input({ id: 'po-expected', type: 'date' })
    const noteInput = input({ id: 'po-note', placeholder: 'Note (optional)' })
    const linesSlot = h('div', { class: 'space-y-2' })
    const totalSlot = h('div', { class: 'text-sm font-semibold tabular-nums text-content' })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })

    const draftButton = button('Save draft', { variant: 'outline' })
    const orderButton = button(existing?.purchase.status === 'ORDERED' ? 'Save changes' : 'Mark as ordered', { variant: 'primary' })
    const dialog = modal({
      title: existing ? `Edit ${existing.purchase.invoiceNo}` : 'New purchase order',
      subtitle: 'A draft costs nothing. Marking it ordered puts the total on the supplier’s account.',
      iconName: 'note_add',
      size: 'lg',
      footer: [h('div', { class: 'flex flex-1 gap-2' }, draftButton, orderButton)],
    })

    renderLines()
    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        h('div', { class: 'grid gap-3 sm:grid-cols-2' }, field('Supplier', supplierSelect), field('Their invoice', referenceInput)),
        h('div', { class: 'grid gap-3 sm:grid-cols-2' }, field('Expected on', expectedInput), field('Note', noteInput)),
        h(
          'div',
          { class: 'flex items-center justify-between' },
          h('h3', { class: 'text-sm font-semibold text-content-muted', text: 'Lines' }),
          button('Add item', { variant: 'secondary', size: 'sm', icon: 'add', onClick: () => void addLine() })
        ),
        linesSlot,
        h('div', { class: 'flex items-center justify-between border-t border-border pt-3' }, h('span', { class: 'text-sm text-content-muted', text: 'Order total' }), totalSlot),
        errorSlot
      )
    )

    function renderLines(): void {
      if (lines.length === 0) {
        mount(
          linesSlot,
          h('p', { class: 'rounded-lg border border-dashed border-border p-4 text-center text-sm text-content-subtle', text: 'No items yet. Add what is coming.' })
        )
      } else {
        mount(
          linesSlot,
          ...lines.map((line, index) =>
            h(
              'div',
              { class: 'flex items-center justify-between gap-3 rounded-lg border border-border p-2.5' },
              h(
                'div',
                { class: 'min-w-0' },
                h('p', { class: 'truncate text-sm text-content', text: line.name }),
                h('p', {
                  class: 'text-xs text-content-muted tabular-nums',
                  text: `${formatQty(line.qty)} × ${formatMoney(line.unitCost, { currency })}`,
                })
              ),
              h(
                'div',
                { class: 'flex shrink-0 items-center gap-2' },
                h('span', { class: 'text-sm tabular-nums text-content', text: formatMoney(lineTotalOf(line), { currency }) }),
                iconButton('edit', `Edit ${line.name}`, {
                  variant: 'ghost',
                  onClick: () => void editLine(index),
                }),
                iconButton('delete', `Remove ${line.name}`, {
                  variant: 'ghost',
                  onClick: () => {
                    lines.splice(index, 1)
                    renderLines()
                    updateTotal()
                  },
                })
              )
            )
          )
        )
      }
      updateTotal()
    }

    function updateTotal(): void {
      const total = lines.reduce((sum, line) => sum + minorToNumber(lineTotalOf(line)), 0)
      totalSlot.textContent = formatMoney(toMinor(total), { currency })
    }

    async function addLine(): Promise<void> {
      const picked = await pickVariant(floor.warehouseId)
      if (!picked) return
      lines.push({
        variantId: picked.product.variantId,
        name: picked.product.variantName ? `${picked.product.name} · ${picked.product.variantName}` : picked.product.name,
        qty: milli(1000),
        // `cost` is ten-thousandths of a taka; the order is in paisa, so the
        // default lands as the last known cost rather than a guess.
        unitCost: toMinor(roundHalfAway(picked.product.cost / 100)),
      })
      renderLines()
      void editLine(lines.length - 1)
    }

    /** Quantity and cost, both editable: a delivery rarely matches the order. */
    async function editLine(index: number): Promise<void> {
      const line = lines[index]
      if (!line) return
      const qtyInput = input({ id: 'po-line-qty', value: String(milliToNumber(line.qty)), inputmode: 'decimal', autofocus: true })
      const costInput = input({ id: 'po-line-cost', value: minorToNumber(line.unitCost).toFixed(2), inputmode: 'decimal' })
      const errorSlotInner = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
      const save = button('Add to order', { variant: 'primary', fullWidth: true })
      const lineDialog = modal({
        title: line.name,
        iconName: 'inventory',
        size: 'sm',
        footer: [h('div', { class: 'w-full' }, save)],
      })

      mount(lineDialog.body, h('div', { class: 'space-y-4' }, field('Quantity', qtyInput, { required: true }), field('Unit cost', costInput, { required: true }), errorSlotInner))

      save.addEventListener('click', () => {
        const qty = parseMilli(qtyInput.value, { decimal: true })
        const cost = parseMinor(costInput.value)
        if (qty === null || milliToNumber(qty) <= 0) {
          errorSlotInner.textContent = 'Enter a quantity greater than zero.'
          errorSlotInner.classList.remove('hidden')
          return
        }
        if (cost === null) {
          errorSlotInner.textContent = 'Enter a unit cost.'
          errorSlotInner.classList.remove('hidden')
          return
        }
        line.qty = qty
        line.unitCost = cost
        lineDialog.close()
        renderLines()
      })
    }

    async function save(status: 'DRAFT' | 'ORDERED'): Promise<void> {
      errorSlot.classList.add('hidden')
      if (lines.length === 0) {
        errorSlot.textContent = 'Add at least one item.'
        errorSlot.classList.remove('hidden')
        return
      }
      draftButton.disabled = true
      orderButton.disabled = true
      try {
        const id = await repos.purchases.save({
          ...(existing ? { id: existing.purchase.id } : {}),
          warehouseId: floor.warehouseId,
          supplierId: supplierSelect.value || null,
          lines: lines.map((line) => ({ variantId: line.variantId, qty: line.qty, unitCost: line.unitCost })),
          status,
          referenceNo: referenceInput.value.trim() || null,
          note: noteInput.value.trim() || null,
          expectedAt: expectedInput.value || null,
        })
        dialog.close()
        toastSuccess(status === 'DRAFT' ? 'Draft saved' : 'Order placed')
        void reload()
        if (status === 'ORDERED') void openDetail(id)
      } catch (error) {
        errorSlot.textContent = translateError(error).message
        errorSlot.classList.remove('hidden')
      } finally {
        draftButton.disabled = false
        orderButton.disabled = false
      }
    }

    draftButton.addEventListener('click', () => void save('DRAFT'))
    orderButton.addEventListener('click', () => void save('ORDERED'))
  }

  // ── Detail: receive, pay, cancel ────────────────────────────────────────

  async function openDetail(purchaseId: string): Promise<void> {
    const dialog = modal({ title: 'Purchase order', size: 'lg', iconName: 'local_shipping' })
    mount(dialog.body, h('div', { class: 'flex justify-center p-6' }, spinner()))

    async function render(): Promise<void> {
      const detail = await repos.purchases.get(purchaseId)
      if (!detail) {
        mount(dialog.body, emptyState('Order not found', { iconName: 'search_off' }))
        return
      }
      const { purchase, items, payments } = detail
      const receivable = items.some((item) => milliToNumber(item.outstanding) > 0)
      const editable = purchase.status === 'DRAFT' || purchase.status === 'ORDERED'

      mount(
        dialog.body,
        h(
          'div',
          { class: 'space-y-4' },
          h(
            'div',
            { class: 'flex flex-wrap items-start justify-between gap-3' },
            h(
              'div',
              { class: 'min-w-0' },
              h('p', { class: 'text-lg font-semibold tabular-nums text-content', text: purchase.invoiceNo }),
              h('p', {
                class: 'text-xs text-content-muted',
                text: [purchase.supplierName ?? 'No supplier', purchase.warehouseName ?? '', purchase.referenceNo ?? ''].filter(Boolean).join(' · '),
              })
            ),
            badge(purchase.status.replace(/_/g, ' ').toLowerCase(), { tone: toneFor(purchase.status) })
          ),

          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            receivable && can('purchases.receive')
              ? button(purchase.status === 'PARTIALLY_RECEIVED' ? 'Receive the rest' : 'Receive', {
                  variant: 'primary',
                  icon: 'move_to_inbox',
                  onClick: () => openReceive(detail, render),
                })
              : null,
            editable && can('purchases.create')
              ? button('Edit', { variant: 'outline', icon: 'edit', onClick: () => { dialog.close(); void openEditor(detail) } })
              : null,
            minorToNumber(purchase.outstanding) > 0 && purchase.supplierId && can('purchases.create')
              ? button('Record payment', { variant: 'secondary', icon: 'payments', onClick: () => openPay(detail, render) })
              : null,
            purchase.status !== 'RECEIVED' && purchase.status !== 'CANCELLED' && can('purchases.approve')
              ? button('Cancel', { variant: 'ghost', icon: 'cancel', onClick: () => openCancel(detail, dialog) })
              : null
          ),

          card(
            h('div', { class: 'divide-y divide-border' }, ...items.map((item) => itemRow(item))),
            h(
              'div',
              { class: 'mt-3 flex items-center justify-between border-t border-border pt-3 text-sm font-semibold' },
              h('span', { text: 'Total' }),
              h('span', { class: 'tabular-nums', text: formatMoney(purchase.total, { currency }) })
            ),
            minorToNumber(purchase.paidTotal) > 0
              ? h(
                  'p',
                  { class: 'mt-1 flex justify-between text-sm' },
                  h('span', { class: 'text-content-muted', text: 'Paid' }),
                  h('span', { class: 'tabular-nums', text: formatMoney(purchase.paidTotal, { currency }) })
                )
              : null,
            minorToNumber(purchase.outstanding) > 0
              ? h(
                  'p',
                  { class: 'mt-1 flex justify-between text-sm font-medium text-warning' },
                  h('span', { text: 'Still due' }),
                  h('span', { class: 'tabular-nums', text: formatMoney(purchase.outstanding, { currency }) })
                )
              : null
          ),

          payments.length > 0
            ? card(
                h('p', { class: 'text-xs font-medium text-content-muted', text: 'Payments' }),
                ...payments.map((payment) =>
                  h(
                    'div',
                    { class: 'mt-1 flex justify-between text-sm' },
                    h('span', { text: `${payment.methodName ?? 'Payment'} · ${new Date(payment.paidAt).toLocaleDateString()}` }),
                    h('span', { class: 'tabular-nums', text: formatMoney(payment.amount, { currency }) })
                  )
                )
              )
            : null,

          purchase.note ? h('p', { class: 'text-sm text-content-muted', text: purchase.note }) : null
        )
      )
    }

    function itemRow(item: PurchaseItemRow): HTMLElement {
      const outstanding = milliToNumber(item.outstanding)
      return h(
        'div',
        { class: 'flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0' },
        h(
          'div',
          { class: 'min-w-0' },
          h('p', { class: 'truncate text-sm text-content', text: item.variantName ? `${item.productName} · ${item.variantName}` : item.productName }),
          h('p', {
            class: 'text-xs text-content-muted tabular-nums',
            text: `${formatQty(item.quantity)} × ${formatMoney(item.unitCost, { currency })}`,
          })
        ),
        h(
          'div',
          { class: 'shrink-0 text-right' },
          h('p', { class: 'text-sm tabular-nums text-content', text: formatMoney(item.lineTotal, { currency }) }),
          // Two states, not one: "received 8 of 20" is the whole point of the
          // partial-receipt flow, so the screen always says both numbers.
          h('p', {
            class: `text-xs tabular-nums ${outstanding > 0 && milliToNumber(item.receivedQty) > 0 ? 'text-warning' : 'text-content-muted'}`,
            text:
              outstanding > 0
                ? `${formatQty(item.receivedQty)} of ${formatQty(item.quantity)} received`
                : `${formatQty(item.receivedQty)} received`,
          })
        )
      )
    }

    try {
      await render()
    } catch (error) {
      mount(dialog.body, emptyState('Could not open the order', { description: translateError(error).message, iconName: 'error' }))
    }
  }

  /**
   * Receiving. Every line starts at what is still outstanding, so a full
   * delivery is one tap and a partial one is an edit — the common case is the
   * cheap one. Costs are editable because suppliers change them on the van.
   */
  function openReceive(detail: PurchaseDetail, onDone: () => Promise<void>): void {
    const outstanding = detail.items.filter((item) => milliToNumber(item.outstanding) > 0)
    const entries = outstanding.map((item) => ({
      item,
      qtyInput: input({ id: `receive-${item.id}`, value: String(milliToNumber(item.outstanding)), inputmode: 'decimal' }),
      costInput: input({ id: `receive-cost-${item.id}`, value: minorToNumber(item.unitCost).toFixed(2), inputmode: 'decimal' }),
    }))

    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const summarySlot = h('p', { class: 'text-sm text-content-muted' })
    const submit = button('Receive into stock', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({
      title: 'Receive stock',
      subtitle: `${detail.purchase.invoiceNo} · ${detail.purchase.supplierName ?? 'No supplier'}`,
      iconName: 'move_to_inbox',
      size: 'md',
      footer: [h('div', { class: 'w-full space-y-2' }, summarySlot, submit)],
    })

    function updateSummary(): void {
      let value = 0
      let units = 0
      for (const entry of entries) {
        const qty = parseMilli(entry.qtyInput.value, { decimal: true })
        const cost = parseMinor(entry.costInput.value)
        if (qty === null || cost === null) continue
        value += minorToNumber(cost) * milliToNumber(qty)
        units += milliToNumber(qty)
      }
      summarySlot.textContent = `${units} unit${units === 1 ? '' : 's'} coming in for ${formatMoney(toMinor(value), { currency })}`
    }

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        h('p', {
          class: 'text-xs text-content-subtle',
          text: 'Quantities start at what is still owed. Reduce them for a short delivery — the rest stays outstanding on the order.',
        }),
        ...entries.map((entry) =>
          h(
            'div',
            { class: 'space-y-2 rounded-lg border border-border p-3' },
            h('p', { class: 'text-sm font-medium text-content', text: entry.item.productName + (entry.item.variantName ? ` · ${entry.item.variantName}` : '') }),
            h('p', { class: 'text-xs text-content-muted tabular-nums', text: `Outstanding ${formatQty(entry.item.outstanding)} of ${formatQty(entry.item.quantity)}` }),
            h('div', { class: 'grid grid-cols-2 gap-3' }, field('Receiving', entry.qtyInput), field('Unit cost', entry.costInput))
          )
        ),
        errorSlot
      )
    )

    for (const entry of entries) {
      entry.qtyInput.addEventListener('input', updateSummary)
      entry.costInput.addEventListener('input', updateSummary)
    }
    updateSummary()

    submit.addEventListener('click', () => {
      void (async () => {
        const lines: { purchaseItemId: string; qty: Milli; unitCost?: Minor }[] = []
        for (const entry of entries) {
          const raw = entry.qtyInput.value.trim()
          if (raw === '' || Number(raw) === 0) continue
          const qty = parseMilli(raw, { decimal: true })
          const cost = parseMinor(entry.costInput.value)
          if (qty === null || cost === null) {
            errorSlot.textContent = 'Check the quantities and costs.'
            errorSlot.classList.remove('hidden')
            return
          }
          if (milliToNumber(qty) > milliToNumber(entry.item.outstanding)) {
            errorSlot.textContent = `Only ${formatQty(entry.item.outstanding)} of ${entry.item.productName} is outstanding.`
            errorSlot.classList.remove('hidden')
            return
          }
          lines.push({ purchaseItemId: entry.item.id, qty, unitCost: cost })
        }

        if (lines.length === 0) {
          errorSlot.textContent = 'Nothing is being received.'
          errorSlot.classList.remove('hidden')
          return
        }

        submit.disabled = true
        try {
          const payments = await promptPayment(detail, lines, entries)
          const result = await repos.purchases.receive(detail.purchase.id, lines, payments)
          dialog.close()
          toastSuccess(
            result.status === 'RECEIVED'
              ? `Order received — ${formatMoney(result.receivedValue, { currency })} of stock in.`
              : `Part received — ${formatMoney(result.receivedValue, { currency })} in. The rest stays outstanding.`
          )
          if (result.paid > 0) toastSuccess(`${formatMoney(result.paid, { currency })} paid to the supplier.`)
          await onDone()
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

  /**
   * Offer to pay at the moment of receiving — the delivery van is the most
   * common place money changes hands, and asking here means the supplier
   * balance is right without a second trip to the screen.
   */
  async function promptPayment(
    detail: PurchaseDetail,
    lines: { purchaseItemId: string; qty: Milli; unitCost?: Minor }[],
    entries: { item: PurchaseItemRow; qtyInput: HTMLInputElement }[]
  ): Promise<{ methodId: string; amount: Minor; reference?: string }[]> {
    const methods = await loadMethods()
    if (methods.length === 0) return []
    const byId = new Map(entries.map((entry) => [entry.item.id, entry]))
    const value = lines.reduce((sum, line) => {
      const item = byId.get(line.purchaseItemId)?.item
      const cost = line.unitCost ?? item?.unitCost ?? minor(0)
      return sum + minorToNumber(cost) * milliToNumber(line.qty)
    }, 0)
    const amount = toMinor(value)
    if (minorToNumber(amount) <= 0) return []

    const choice = await confirm(`Pay ${formatMoney(amount, { currency })} now?`, {
      message: `Hand this delivery's value to ${detail.purchase.supplierName ?? 'the supplier'} straight away, or leave it on their account.`,
      confirmLabel: 'Pay now',
      cancelLabel: 'Leave on account',
      iconName: 'payments',
      tone: 'primary',
    })
    if (!choice) return []

    const cash = methods.find((method) => method.is_cash) ?? methods[0]
    return cash ? [{ methodId: cash.id, amount }] : []
  }

  function openPay(detail: PurchaseDetail, onDone: () => Promise<void>): void {
    void (async () => {
      const methods = await loadMethods()
      const amountInput = input({ id: 'po-pay-amount', inputmode: 'decimal', autofocus: true, value: minorToNumber(detail.purchase.outstanding).toFixed(2) })
      const methodSelect = select({ id: 'po-pay-method', options: methods.map((method) => ({ value: method.id, label: method.name })), ...(methods[0] ? { value: methods[0].id } : {}) })
      const referenceInput = input({ id: 'po-pay-ref', placeholder: 'Reference (optional)' })
      const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
      const submit = button('Record payment', { variant: 'primary', fullWidth: true, size: 'lg' })
      const dialog = modal({
        title: 'Pay for this order',
        subtitle: `${formatMoney(detail.purchase.outstanding, { currency })} outstanding on ${detail.purchase.invoiceNo}`,
        iconName: 'payments',
        size: 'sm',
        footer: [h('div', { class: 'w-full' }, submit)],
      })

      mount(dialog.body, h('div', { class: 'space-y-4' }, field('Amount', amountInput, { required: true }), field('Paid with', methodSelect), field('Reference', referenceInput), errorSlot))

      submit.addEventListener('click', () => {
        void (async () => {
          const amount = parseMinor(amountInput.value)
          if (amount === null || minorToNumber(amount) <= 0) {
            errorSlot.textContent = 'Enter an amount greater than zero.'
            errorSlot.classList.remove('hidden')
            return
          }
          submit.disabled = true
          try {
            await repos.purchases.pay({
              supplierId: detail.purchase.supplierId ?? '',
              amount,
              methodId: methodSelect.value,
              purchaseId: detail.purchase.id,
              reference: referenceInput.value.trim() || null,
            })
            dialog.close()
            toastSuccess('Payment recorded')
            await onDone()
            void reload()
          } catch (error) {
            errorSlot.textContent = translateError(error).message
            errorSlot.classList.remove('hidden')
          } finally {
            submit.disabled = false
          }
        })()
      })
    })()
  }

  async function openCancel(detail: PurchaseDetail, parent: ReturnType<typeof modal>): Promise<void> {
    const ok = await confirm(`Cancel ${detail.purchase.invoiceNo}?`, {
      message:
        detail.purchase.status === 'RECEIVED' || minorToNumber(detail.purchase.paidTotal) > 0
          ? 'Anything paid and not yet received is released back to the supplier’s balance.'
          : 'Nothing has been received, so cancelling simply closes the order.',
      confirmLabel: 'Cancel order',
      cancelLabel: 'Keep it',
      tone: 'danger',
      iconName: 'cancel',
    })
    if (!ok) return
    try {
      const result = await repos.purchases.cancel(detail.purchase.id, 'Cancelled from the purchases screen')
      parent.close()
      toastSuccess(minorToNumber(result.released) > 0 ? `Order cancelled, ${formatMoney(result.released, { currency })} released` : 'Order cancelled')
      void reload()
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  /** The buy-side product search: name, SKU or barcode, priced from the catalog. */
  function pickVariant(warehouseId: string): Promise<{ product: SellableProduct } | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: { product: SellableProduct } | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const resultsSlot = h('div', { class: 'max-h-80 space-y-1 overflow-y-auto' })
      const searchBox = searchInput('Search a product to buy…', (value) => void run(value))
      const dialog = modal({ title: 'Add an item', iconName: 'search', size: 'md', onClose: () => finish(null) })

      async function run(term: string): Promise<void> {
        if (term.trim().length < 2) {
          mount(resultsSlot, h('p', { class: 'py-4 text-center text-sm text-content-subtle', text: 'Type at least two characters.' }))
          return
        }
        try {
          const page = await repos.catalog.searchProducts({ search: term.trim(), warehouseId, limit: 20 })
          if (page.items.length === 0) {
            mount(resultsSlot, h('p', { class: 'py-4 text-center text-sm text-content-subtle', text: 'Nothing matched.' }))
            return
          }
          mount(
            resultsSlot,
            ...page.items.map((product) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'flex w-full min-h-[56px] items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-left hover:bg-surface-muted',
                  onclick: () => {
                    // Resolve the selected product before closing. `close()`
                    // invokes the modal's onClose callback synchronously; the
                    // old order resolved this promise as null first, so every
                    // product click silently behaved like Cancel.
                    finish({ product })
                    dialog.close()
                  },
                },
                h(
                  'div',
                  { class: 'min-w-0' },
                  h('p', { class: 'truncate text-sm text-content', text: product.name }),
                  h('p', { class: 'text-xs text-content-muted', text: [product.variantName, product.sku].filter(Boolean).join(' · ') || 'Default' })
                ),
                h('span', { class: 'shrink-0 text-xs tabular-nums text-content-muted', text: `last cost ${formatMoney(toMinor(roundHalfAway(product.cost / 100)), { currency })}` })
              )
            )
          )
        } catch (error) {
          mount(resultsSlot, h('p', { class: 'py-4 text-center text-sm text-danger', text: translateError(error).message }))
        }
      }

      mount(dialog.body, h('div', { class: 'space-y-3' }, searchBox, resultsSlot))
      mount(resultsSlot, h('p', { class: 'py-4 text-center text-sm text-content-subtle', text: 'Search for what you are buying.' }))
      searchBox.focus()
    })
  }

  // ── Shared lookups ──────────────────────────────────────────────────────

  let supplierCache: SupplierRow[] | null = null
  async function loadSuppliers(): Promise<SupplierRow[]> {
    if (supplierCache) return supplierCache
    try {
      supplierCache = (await repos.suppliers.list({ limit: 100 })).items
    } catch {
      supplierCache = []
    }
    return supplierCache
  }

  let methodCache: PaymentMethod[] | null = null
  async function loadMethods(): Promise<PaymentMethod[]> {
    if (methodCache) return methodCache
    try {
      methodCache = (await repos.catalog.listPaymentMethods()).filter((method) => method.is_active)
    } catch {
      methodCache = []
    }
    return methodCache
  }

  async function ensureFloor(): Promise<{ warehouseId: string }> {
    if (!salesFloor()) await refreshSalesFloor()
    const floor = salesFloor()
    if (!floor) throw new Error('The shop is still loading. Try again in a moment.')
    return { warehouseId: floor.warehouseId }
  }

  mount(
    root,
    h(
      'div',
      { class: 'border-b border-border px-3 pt-3 pb-3' },
      h('div', { class: 'flex items-center justify-between gap-3' }, h('h1', { class: 'text-lg font-semibold text-content', text: 'Purchases' }),
        can('purchases.create')
          ? button('New order', { variant: 'primary', icon: 'add', onClick: () => void openEditor(null) })
          : null)
    ),
    h('div', { class: 'space-y-2 border-b border-border px-3 pb-3' }, searchBox, statusTabs),
    listSlot,
    footerSlot
  )

  void reload()
  return root
}

function toneFor(status: PurchaseRow['status']): 'success' | 'warning' | 'neutral' | 'danger' {
  if (status === 'RECEIVED') return 'success'
  if (status === 'PARTIALLY_RECEIVED') return 'warning'
  if (status === 'CANCELLED') return 'danger'
  return 'neutral'
}

function lineTotalOf(line: DraftLine): Minor {
  return toMinor(minorToNumber(line.unitCost) * milliToNumber(line.qty))
}
