/**
 * Stock operations dialog: receive, write off, adjust, transfer.
 *
 * One dialog for four verbs, because they are the same act — pick a product,
 * type a quantity, say why — and four separate screens would mean four places
 * to fix the same bug. What differs is the fields and the function called.
 *
 * Two rules this file follows deliberately:
 *
 *   The quantity field is a plain number box with `inputmode="decimal"`, not a
 *   custom stepper. A shopkeeper receiving 240 units types 240; a stepper that
 *   has to be tapped 240 times is worse than useless, and a phone shows the
 *   numeric keypad for this attribute.
 *
 *   Nothing is optimistic. The dialog waits for the RPC, because the RPC is the
 *   only thing that knows whether the stock was actually there — a screen that
 *   decrements first and apologises later teaches the shopkeeper not to trust
 *   their own numbers.
 */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { input, select, field, textarea } from '../../components/ui/input'
import { modal, type Modal } from '../../components/feedback/modal'
import { getRepositories } from '../../app/data'
import { translateError } from '../../app/platform/errors'
import {
  formatMoney,
  formatQty,
  parseMilli,
  parseMinor,
  type Milli,
} from '../../shared/domain/money'
import type { StockRow, WarehouseOption } from '../../shared/repositories/contracts'
import { salesFloor } from '../../app/state/sales-floor'

export type StockDialogMode = 'in' | 'out' | 'transfer' | 'adjust'

export interface StockDialogOptions {
  mode: StockDialogMode
  currency: string
  warehouses: WarehouseOption[]
  /** Optionally pre-select a product (from a row action). */
  product?: StockRow
  onDone: (message: string) => void
}

/** The reasons the ledger understands, with the words a shopkeeper would use. */
const STOCK_OUT_REASONS = [
  { value: 'damage', label: 'Damaged' },
  { value: 'loss', label: 'Lost' },
  { value: 'theft', label: 'Stolen' },
  { value: 'expired', label: 'Expired' },
  { value: 'other', label: 'Other' },
]

const TITLES: Record<StockDialogMode, { title: string; icon: string; submit: string }> = {
  in: { title: 'Stock in', icon: 'add_box', submit: 'Receive stock' },
  out: { title: 'Stock out', icon: 'remove_circle', submit: 'Write off' },
  transfer: { title: 'Transfer stock', icon: 'swap_horiz', submit: 'Transfer' },
  adjust: { title: 'Adjust stock', icon: 'tune', submit: 'Record adjustment' },
}

/** Adjustment directions, in the words a shopkeeper would use. */
const ADJUST_DIRECTIONS = [
  { value: '1', label: 'Found extra (increase)' },
  { value: '-1', label: 'Correct down (decrease)' },
]

export function openStockDialog(options: StockDialogOptions): Modal {
  const { mode, currency, warehouses, onDone } = options
  const repos = getRepositories()
  const floor = salesFloor()
  const labels = TITLES[mode]

  // For a transfer the source is never a free choice: stock always leaves the
  // branch you are standing in, so "From" is pinned to this branch's own
  // location (the retail floor) and shown disabled. The destination — which may
  // be another branch — is the only side the user picks.
  const defaultWarehouseId =
    mode === 'in' || mode === 'out' || mode === 'transfer'
      ? (floor?.warehouseId ?? warehouses[0]?.id ?? '')
      : (warehouses[0]?.id ?? '')

  // ── Fields ──────────────────────────────────────────────────────────────
  const productSearch = input({
    id: 'stock-product',
    type: 'search',
    placeholder: 'Scan a barcode or type a product name…',
    autocomplete: 'off',
    autofocus: true,
    onInput: (value) => void searchProducts(value),
  })

  const resultsSlot = h('div', { class: 'max-h-52 overflow-y-auto rounded-lg border border-border empty:hidden' })
  const chosenSlot = h('div', { class: 'rounded-lg border border-border bg-surface-muted p-3 empty:hidden' })

  const qtyInput = input({
    id: 'stock-qty',
    type: 'text',
    inputmode: 'decimal',
    placeholder: '0',
    autocomplete: 'off',
  })

  const costInput = input({
    id: 'stock-cost',
    type: 'text',
    inputmode: 'decimal',
    placeholder: 'Leave blank for the last cost',
    autocomplete: 'off',
  })

  const reasonSelect = select({
    id: 'stock-reason',
    options: STOCK_OUT_REASONS,
    value: 'damage',
  })

  const warehouseSelect = select({
    id: 'stock-warehouse-from',
    options: warehouses.map((w) => ({ value: w.id, label: w.name })),
    value: defaultWarehouseId,
  })

  // The source of a transfer is fixed to the current branch — locked, not just
  // defaulted — so a user can never move stock out of a branch they are not in.
  // A disabled <select> still reports its `.value`, which the submit handler
  // reads, so the transfer knows where the stock is leaving from.
  if (mode === 'transfer') {
    warehouseSelect.disabled = true
    warehouseSelect.classList.add(
      'disabled:cursor-not-allowed',
      'disabled:bg-surface-muted',
      'disabled:opacity-70'
    )
  }

  const targetSelect = select({
    id: 'stock-warehouse-to',
    options: warehouses.filter((w) => w.id !== defaultWarehouseId).map((w) => ({ value: w.id, label: w.name })),
  })

  const directionSelect = select({
    id: 'stock-direction',
    options: ADJUST_DIRECTIONS,
    value: '-1',
  })

  const noteInput = textarea({
    id: 'stock-note',
    rows: 2,
    placeholder: mode === 'out' ? 'What happened? (optional)' : 'Reference or note (optional)',
  })

  const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
  const resultSlot = h('div', { class: 'empty:hidden' })

  let chosen: StockRow | null = options.product ?? null
  let searching = false

  function showError(message: string): void {
    errorSlot.textContent = message
    errorSlot.classList.remove('hidden')
  }

  function clearError(): void {
    errorSlot.classList.add('hidden')
  }

  // ── Product selection ───────────────────────────────────────────────────
  function renderChosen(): void {
    if (!chosen) {
      mount(chosenSlot)
      return
    }
    mount(
      chosenSlot,
      h(
        'div',
        { class: 'flex items-start justify-between gap-2' },
        h(
          'div',
          { class: 'min-w-0' },
          h('p', { class: 'truncate text-sm font-medium text-content', text: chosen.productName }),
          h('p', {
            class: 'text-xs text-content-muted',
            text: [
              chosen.variantName,
              `on hand ${formatQty(chosen.quantity)}`,
              `at ${formatMoney(chosen.avgUnitCost, { currency })}`,
            ]
              .filter(Boolean)
              .join(' · '),
          })
        ),
        h('button', {
          type: 'button',
          class: 'shrink-0 text-xs font-medium text-primary hover:underline',
          text: 'Change',
          onclick: () => {
            chosen = null
            renderChosen()
            productSearch.focus()
          },
        })
      )
    )
  }

  async function searchProducts(term: string): Promise<void> {
    const text = term.trim()
    if (text.length < 1) {
      mount(resultsSlot)
      return
    }
    if (searching) return
    searching = true
    mount(resultsSlot, h('div', { class: 'flex justify-center p-3' }, spinner()))
    try {
      const page = await repos.stock.list({ search: text, limit: 8 })
      if (page.items.length === 0) {
        mount(
          resultsSlot,
          h('p', { class: 'p-3 text-sm text-content-muted', text: 'Nothing matches that.' })
        )
        return
      }
      mount(
        resultsSlot,
        ...page.items.map((row) =>
          h(
            'button',
            {
              type: 'button',
              class:
                'flex w-full min-h-[48px] items-center justify-between gap-3 border-b border-border ' +
                'p-3 text-left last:border-b-0 hover:bg-surface-muted',
              onclick: () => {
                chosen = row
                renderChosen()
                mount(resultsSlot)
                productSearch.value = ''
                qtyInput.focus()
              },
            },
            h(
              'span',
              { class: 'min-w-0' },
              h('span', { class: 'block truncate text-sm text-content', text: row.productName }),
              h('span', {
                class: 'block text-xs text-content-muted',
                text: [row.variantName, row.warehouseName].filter(Boolean).join(' · '),
              })
            ),
            h('span', {
              class: 'shrink-0 text-sm tabular-nums text-content-muted',
              text: formatQty(row.quantity),
            })
          )
        )
      )
    } catch (error) {
      showError(translateError(error).message)
    } finally {
      searching = false
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  const submit = button(labels.submit, { variant: mode === 'out' ? 'danger' : 'primary', fullWidth: true, size: 'lg' })

  async function go(): Promise<void> {
    clearError()
    const product = chosen
    if (!product) {
      showError('Choose a product first.')
      return
    }
    const qty: Milli | null = parseMilli(qtyInput.value)
    if (!qty || qty <= 0) {
      showError('Enter a quantity greater than zero.')
      return
    }

    const warehouseId = warehouseSelect.value
    if (!warehouseId) {
      showError('Choose a stock location.')
      return
    }

    submit.disabled = true
    const original = submit.textContent
    submit.textContent = 'Saving…'

    try {
      if (mode === 'in') {
        const costText = costInput.value.trim()
        const cost = costText ? parseMinor(costText) : null
        if (costText && cost === null) {
          showError('That cost is not a number.')
          return
        }
        const result = await repos.stock.stockIn(warehouseId, [
          { variantId: product.variantId, qty, ...(cost === null ? {} : { unitCost: cost }) },
        ], { note: noteInput.value.trim() || null })
        resultSlot.replaceChildren(
          receipt([
            `${formatQty(result.totalQty)} received`,
            result.totalCost === undefined ? '' : formatMoney(result.totalCost, { currency }),
          ])
        )
        onDone(`Received ${formatQty(result.totalQty)} of ${product.productName}`)
      } else if (mode === 'out') {
        const result = await repos.stock.stockOut(
          warehouseId,
          [{ variantId: product.variantId, qty }],
          reasonSelect.value,
          noteInput.value.trim() || null
        )
        onDone(`Wrote off ${formatQty(result.totalQty)} of ${product.productName}`)
      } else if (mode === 'adjust') {
        const direction = directionSelect.value === '1' ? 1 : -1
        await repos.stock.adjust(
          warehouseId,
          product.variantId,
          qty,
          reasonSelect.value,
          direction as 1 | -1,
          noteInput.value.trim() || null
        )
        onDone(`Adjusted ${product.productName} by ${direction === 1 ? '+' : '−'}${formatQty(qty)}`)
      } else {
        const toWarehouseId = targetSelect.value
        if (!toWarehouseId) {
          showError('Choose where the stock is going.')
          return
        }
        if (toWarehouseId === warehouseId) {
          showError('The two stock locations are the same.')
          return
        }
        await repos.stock.transfer(warehouseId, toWarehouseId, [{ variantId: product.variantId, qty }], noteInput.value.trim() || null)
        onDone(`Moved ${formatQty(qty)} of ${product.productName}`)
      }
      dialog.close()
    } catch (error) {
      // The database is the authority on whether the stock was there. Its
      // refusal is shown in its own words, translated, and nothing changed.
      showError(translateError(error).message)
    } finally {
      submit.disabled = false
      submit.textContent = original
    }
  }

  submit.addEventListener('click', () => void go())

  function receipt(lines: string[]): HTMLElement {
    return h(
      'div',
      { class: 'mt-3 rounded-lg border border-success/40 bg-success/10 p-3 text-sm' },
      ...lines.filter(Boolean).map((line) => h('p', { text: line }))
    )
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  const body = h(
    'div',
    { class: 'space-y-4' },
    chosen ? null : h('div', { class: 'space-y-2' }, productSearch, resultsSlot),
    chosenSlot,
    h(
      'div',
      { class: 'grid gap-4 sm:grid-cols-2' },
      field('Quantity', qtyInput, { required: true }),
      mode === 'in' ? field('Unit cost', costInput, { hint: 'Blank uses the last recorded cost.' }) : null,
      mode === 'out' || mode === 'adjust' ? field('Reason', reasonSelect, { required: true }) : null,
      mode === 'adjust' ? field('Direction', directionSelect, { required: true }) : null,
      mode === 'transfer'
        ? field('From', warehouseSelect, {
            required: true,
            hint: 'Stock always moves out of the branch you are in.',
          })
        : warehouses.length > 0
          ? field('Stock location', warehouseSelect, { required: true })
          : null,
      mode === 'transfer' ? field('To', targetSelect, { required: true }) : null
    ),
    field('Note', noteInput),
    errorSlot,
    resultSlot
  )

  const dialog = modal({
    title: labels.title,
    subtitle:
      mode === 'in'
        ? 'Receive a delivery. The cost updates the weighted average.'
        : mode === 'out'
          ? 'Stock that left without being sold. Recorded against a reason.'
          : mode === 'adjust'
            ? 'Correct the count to match what is on the shelf. The reason goes on the ledger.'
            : 'Move stock between stock locations without changing what it is worth.',
    iconName: labels.icon,
    size: 'md',
    footer: [h('div', { class: 'w-full' }, submit)],
    onClose: () => undefined,
  })

  // `dialog.body` is the modal's own content element; mount into it rather
  // than replacing it, so the modal keeps ownership of its scroll container.
  dialog.body.replaceChildren(body)
  renderChosen()

  // Enter submits, as in every other form in the app.
  for (const el of [qtyInput, costInput, noteInput]) {
    el.addEventListener('keydown', (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void go()
      }
    })
  }

  queueMicrotask(() => (chosen ? qtyInput : productSearch).focus())

  return dialog
}
