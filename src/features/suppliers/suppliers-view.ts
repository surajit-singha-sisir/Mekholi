/**
 * Suppliers (spec §20).
 *
 * A supplier screen is really two things at once: an address book, and a
 * running account. The balance is shown as prominently as the name because it
 * is the number that decides whether the next delivery is collected or
 * refused — and because it is derived from the purchase ledger rather than
 * typed in, it can be trusted without opening a single order.
 *
 * The card itself carries what every serious trade book worldwide carries —
 * the person to phone, the terms the goods travel on (COD, advance, net-N),
 * the BIN/TIN an NBR-compliant purchase invoice needs, and the bank account
 * or bKash/Nagad wallet the money actually goes to. All of it lives in the
 * suppliers.metadata column, so the card can keep growing without a
 * migration.
 *
 * Payment is recorded against the supplier, not the order, because that is how
 * a delivery works: the van arrives with three invoices and the shop pays once.
 * `apply_payment` allocates it oldest-first on the server; the screen only
 * asks for the amount.
 */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { badge, card, emptyState } from '../../components/ui/card'
import { input, field, searchInput, select } from '../../components/ui/input'
import { dataTable } from '../../components/ui/table'
import { exportToolbar, sortReportRows } from '../../components/ui/table-tools'
import { modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization, can } from '../../app/state/session'
import { formatMoney, minor, minorToNumber, parseMinor } from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { PaymentMethod } from '../../shared/types/records'
import type {
  PurchaseRow,
  ReportCell,
  ReportColumn,
  SupplierRow,
} from '../../shared/repositories/contracts'

export interface SuppliersViewOptions {
  /** Used for "raise an order", which belongs to the purchases screen. */
  onNavigate?: (path: string) => void
}

/** Payment terms the trade actually uses, key → what the shopkeeper reads. */
const PAYMENT_TERMS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Not set' },
  { value: 'cod', label: 'On delivery (COD)' },
  { value: 'advance', label: 'Advance payment' },
  { value: 'net7', label: 'Net 7 days' },
  { value: 'net15', label: 'Net 15 days' },
  { value: 'net30', label: 'Net 30 days' },
  { value: 'net45', label: 'Net 45 days' },
  { value: 'net60', label: 'Net 60 days' },
]

function termsLabel(value: string): string {
  return PAYMENT_TERMS.find((term) => term.value === value)?.label ?? value
}

/** A string field out of the metadata bag, or '' when it was never filled. */
function meta(row: SupplierRow, key: string): string {
  const value = row.metadata[key]
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

/** The supplier book's columns — screen, CSV, picture and printout alike. */
const SUPPLIER_COLUMNS: readonly ReportColumn[] = [
  { key: 'name', label: 'Supplier', type: 'text' },
  { key: 'contact', label: 'Contact person', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'terms', label: 'Terms', type: 'text' },
  { key: 'supplies', label: 'Supplies', type: 'text' },
  { key: 'balance', label: 'We owe', type: 'money', align: 'right' },
  { key: 'status', label: 'Status', type: 'status' },
]

export function suppliersView(options: SuppliersViewOptions = {}): HTMLElement {
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'

  let search = ''
  let rows: SupplierRow[] = []
  let cursor: string | null = null
  let loading = false
  let sortKey: string | undefined
  let sortDir: 'asc' | 'desc' = 'desc'

  const root = h('div', { class: 'flex w-full min-w-0 flex-col' })
  const summarySlot = h('div', { class: 'grid grid-cols-2 gap-2 p-3 sm:grid-cols-4' })
  const listSlot = h('div', { class: 'p-3' })
  const footerSlot = h('div', { class: 'border-t border-border p-3' })

  const searchBox = searchInput('Search name, phone or email…', (value) => {
    search = value
    void reload()
  })

  async function reload(): Promise<void> {
    if (loading) return
    loading = true
    cursor = null
    mount(listSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    try {
      const page = await repos.suppliers.list({ limit: 30, ...(search.trim() ? { search } : {}) })
      rows = page.items
      cursor = page.nextCursor
      render()
    } catch (error) {
      mount(
        listSlot,
        emptyState('Suppliers could not be loaded', { description: translateError(error).message, iconName: 'error' })
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
      const page = await repos.suppliers.list({ limit: 30, cursor, ...(search.trim() ? { search } : {}) })
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

  // ── The table ───────────────────────────────────────────────────────────

  function toReportRow(row: SupplierRow): Record<string, ReportCell> {
    return {
      id: row.id,
      name: row.name,
      contact: meta(row, 'contact_person') || null,
      phone: row.phone,
      terms: meta(row, 'payment_terms') ? termsLabel(meta(row, 'payment_terms')) : null,
      supplies: meta(row, 'supplies') || null,
      balance: Number(row.balance),
      status: minorToNumber(row.balance) > 0 ? 'due' : 'settled',
    }
  }

  function visibleRows(): Record<string, ReportCell>[] {
    const mapped = rows.map(toReportRow)
    return sortKey ? sortReportRows(SUPPLIER_COLUMNS, mapped, sortKey, sortDir) : mapped
  }

  function renderSummary(): void {
    const owed = rows.reduce((sum, row) => sum + minorToNumber(row.balance), 0)
    const withDues = rows.filter((row) => minorToNumber(row.balance) > 0).length
    mount(
      summarySlot,
      statCard('Suppliers', String(rows.length), 'handshake'),
      statCard('We owe', formatMoney(minor(Math.round(owed * 100)), { currency }), 'payments', owed > 0 ? 'warning' : undefined),
      statCard('With dues', String(withDues), 'schedule', withDues > 0 ? 'warning' : undefined),
      statCard('Settled', String(rows.length - withDues), 'check_circle')
    )
  }

  function statCard(label: string, value: string, iconName: string, tone?: 'warning'): HTMLElement {
    return card(
      h(
        'div',
        { class: 'flex items-start justify-between gap-2' },
        h('p', { class: 'text-xs font-medium text-content-muted', text: label }),
        h('span', { class: 'material-symbols-rounded text-content-subtle', 'aria-hidden': 'true', text: iconName })
      ),
      h('p', {
        class: `mt-1 text-xl font-semibold tabular-nums ${tone === 'warning' ? 'text-warning' : 'text-content'}`,
        text: value,
      })
    )
  }

  function render(): void {
    renderSummary()
    if (rows.length === 0) {
      mount(
        listSlot,
        emptyState('No suppliers yet', {
          description: 'Add the people you buy from. Their balance is kept from the orders you receive — nothing to type in.',
          iconName: 'handshake',
          ...(can('suppliers.create') ? { action: button('Add supplier', { variant: 'primary', icon: 'add', onClick: () => openForm(null) }) } : {}),
        })
      )
      return
    }

    const visible = visibleRows()
    const owedTotal = visible.reduce((sum, row) => sum + Number(row['balance'] ?? 0), 0)

    const toolbar = exportToolbar({
      title: 'Suppliers',
      filename: 'suppliers',
      columns: SUPPLIER_COLUMNS,
      currency,
      rows: () => visibleRows(),
      subtitle: () =>
        `${visible.length} supplier${visible.length === 1 ? '' : 's'} · ` +
        `${formatMoney(minor(owedTotal), { currency, digits: 'latin', convert: false })} owed`,
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
            columns: SUPPLIER_COLUMNS,
            rows: visible,
            totals: { balance: owedTotal },
            currency,
            sort: sortKey,
            dir: sortDir,
            onSort: (key) => {
              if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
              else {
                sortKey = key
                sortDir = SUPPLIER_COLUMNS.find((c) => c.key === key)?.type === 'money' ? 'desc' : 'asc'
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
          text: `${rows.length} supplier${rows.length === 1 ? '' : 's'}${cursor ? ' · more' : ''}`,
        }),
        cursor ? button('Load more', { variant: 'outline', onClick: () => void loadMore() }) : null
      )
    )
  }

  // ── Create / edit ───────────────────────────────────────────────────────

  function openForm(existing: SupplierRow | null): void {
    const get = (key: string): string => (existing ? meta(existing, key) : '')

    const nameInput = input({ id: 'supplier-name', value: existing?.name ?? '', autofocus: true, placeholder: 'Karim Wholesale' })
    const contactInput = input({ id: 'supplier-contact', value: get('contact_person'), placeholder: 'Who to call' })
    const phoneInput = input({ id: 'supplier-phone', value: existing?.phone ?? '', inputmode: 'tel', placeholder: '01XXXXXXXXX' })
    const emailInput = input({ id: 'supplier-email', type: 'email', value: existing?.email ?? '' })
    const websiteInput = input({ id: 'supplier-website', value: get('website'), placeholder: 'example.com (optional)' })
    const addressInput = input({ id: 'supplier-address', value: existing?.address ?? '' })

    const termsSelect = select({
      id: 'supplier-terms',
      options: PAYMENT_TERMS.map((term) => ({ value: term.value, label: term.label })),
      value: get('payment_terms'),
    })
    const leadInput = input({ id: 'supplier-lead', inputmode: 'numeric', value: get('lead_time_days'), placeholder: 'e.g. 3' })
    const suppliesInput = input({ id: 'supplier-supplies', value: get('supplies'), placeholder: 'e.g. rice, oil, spices' })

    const binInput = input({ id: 'supplier-bin', value: get('bin'), placeholder: 'e.g. 001234567-0101' })
    const tinInput = input({ id: 'supplier-tin', value: get('tin') })

    const bankNameInput = input({ id: 'supplier-bank', value: get('bank_name'), placeholder: 'Bank and branch' })
    const bankAccountInput = input({ id: 'supplier-account', value: get('bank_account'), placeholder: 'Account number' })
    const walletInput = input({ id: 'supplier-wallet', value: get('wallet_number'), inputmode: 'tel', placeholder: 'bKash / Nagad number' })

    const noteInput = input({ id: 'supplier-note', value: existing?.note ?? '' })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })

    const section = (title: string, ...children: (HTMLElement | null)[]): HTMLElement =>
      h(
        'div',
        { class: 'space-y-3' },
        h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-content-muted', text: title }),
        ...children
      )

    const submit = button(existing ? 'Save changes' : 'Add supplier', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({
      title: existing ? 'Edit supplier' : 'New supplier',
      subtitle: 'Only the name is required. Everything else can be filled in later.',
      iconName: 'handshake',
      size: 'lg',
      footer: [h('div', { class: 'w-full' }, submit)],
    })

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-6' },
        section(
          'Who they are',
          field('Name', nameInput, { required: true }),
          h('div', { class: 'grid gap-3 sm:grid-cols-2' },
            field('Contact person', contactInput),
            field('Phone', phoneInput),
            field('Email', emailInput),
            field('Website', websiteInput)
          ),
          field('Address', addressInput)
        ),
        section(
          'How you trade',
          h('div', { class: 'grid gap-3 sm:grid-cols-3' },
            field('Payment terms', termsSelect),
            field('Lead time (days)', leadInput, { hint: 'Order to delivery.' }),
            field('What they supply', suppliesInput)
          )
        ),
        section(
          'Tax registration',
          h('div', { class: 'grid gap-3 sm:grid-cols-2' },
            field('BIN (VAT reg. no.)', binInput, { hint: 'Needed on an NBR-compliant purchase invoice.' }),
            field('TIN', tinInput)
          )
        ),
        section(
          'How you pay them',
          h('div', { class: 'grid gap-3 sm:grid-cols-3' },
            field('Bank', bankNameInput),
            field('Account no.', bankAccountInput),
            field('Mobile wallet', walletInput)
          )
        ),
        field('Note', noteInput),
        errorSlot
      )
    )

    submit.addEventListener('click', () => {
      void (async () => {
        const name = nameInput.value.trim()
        if (!name) {
          errorSlot.textContent = 'A supplier needs a name.'
          errorSlot.classList.remove('hidden')
          return
        }
        const lead = leadInput.value.trim()
        if (lead && (!/^\d+$/.test(lead) || Number(lead) > 365)) {
          errorSlot.textContent = 'Lead time is a number of days, up to 365.'
          errorSlot.classList.remove('hidden')
          return
        }
        submit.disabled = true
        try {
          // Merge over what was there: keys some other screen may one day
          // write into metadata survive an edit made here.
          const metadata: Record<string, unknown> = { ...(existing?.metadata ?? {}) }
          const put = (key: string, value: string): void => {
            if (value) metadata[key] = value
            else delete metadata[key]
          }
          put('contact_person', contactInput.value.trim())
          put('website', websiteInput.value.trim())
          put('payment_terms', termsSelect.value)
          put('lead_time_days', lead)
          put('supplies', suppliesInput.value.trim())
          put('bin', binInput.value.trim())
          put('tin', tinInput.value.trim())
          put('bank_name', bankNameInput.value.trim())
          put('bank_account', bankAccountInput.value.trim())
          put('wallet_number', walletInput.value.trim())

          const draft = {
            name,
            phone: phoneInput.value.trim() || null,
            email: emailInput.value.trim() || null,
            address: addressInput.value.trim() || null,
            note: noteInput.value.trim() || null,
            metadata,
          }
          if (existing) await repos.suppliers.update(existing.id, draft)
          else await repos.suppliers.create(draft)
          dialog.close()
          toastSuccess(existing ? 'Supplier updated' : 'Supplier added')
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

  // ── Detail: the card, balance, history, payment ─────────────────────────

  async function openDetail(supplierId: string): Promise<void> {
    const dialog = modal({ title: 'Supplier', size: 'lg', iconName: 'handshake' })
    mount(dialog.body, h('div', { class: 'flex justify-center p-6' }, spinner()))

    async function render(): Promise<void> {
      const supplier = await repos.suppliers.get(supplierId)
      if (!supplier) {
        mount(dialog.body, emptyState('Supplier not found', { iconName: 'search_off' }))
        return
      }
      const history = await repos.suppliers.purchases(supplierId, { limit: 20 })

      const detail = (label: string, value: string): HTMLElement | null =>
        value
          ? h(
              'div',
              { class: 'min-w-0' },
              h('p', { class: 'text-[11px] uppercase tracking-wide text-content-subtle', text: label }),
              h('p', { class: 'truncate text-sm text-content', text: value })
            )
          : null

      const cardRows = [
        detail('Contact person', meta(supplier, 'contact_person')),
        detail('Phone', supplier.phone ?? ''),
        detail('Email', supplier.email ?? ''),
        detail('Website', meta(supplier, 'website')),
        detail('Address', supplier.address ?? ''),
        detail('Payment terms', meta(supplier, 'payment_terms') ? termsLabel(meta(supplier, 'payment_terms')) : ''),
        detail('Lead time', meta(supplier, 'lead_time_days') ? `${meta(supplier, 'lead_time_days')} day(s)` : ''),
        detail('Supplies', meta(supplier, 'supplies')),
        detail('BIN (VAT)', meta(supplier, 'bin')),
        detail('TIN', meta(supplier, 'tin')),
        detail('Bank', [meta(supplier, 'bank_name'), meta(supplier, 'bank_account')].filter(Boolean).join(' · ')),
        detail('Mobile wallet', meta(supplier, 'wallet_number')),
        detail('Note', supplier.note ?? ''),
      ].filter((row): row is HTMLElement => row !== null)

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
              h('p', { class: 'text-lg font-semibold text-content', text: supplier.name }),
              h('p', {
                class: 'text-xs text-content-muted',
                text: [supplier.phone, supplier.email].filter(Boolean).join(' · ') || 'No contact details',
              })
            ),
            h(
              'div',
              { class: 'text-right' },
              h('p', { class: 'text-xs text-content-muted', text: 'We owe' }),
              h('p', {
                class: 'text-lg font-semibold tabular-nums text-content',
                text: formatMoney(supplier.balance, { currency }),
              })
            )
          ),

          cardRows.length > 0
            ? card(h('div', { class: 'grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3' }, ...cardRows))
            : null,

          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            can('purchases.create')
              ? button('Raise an order', {
                  variant: 'primary',
                  icon: 'note_add',
                  onClick: () => {
                    dialog.close()
                    options.onNavigate?.(`/purchases?supplier=${supplier.id}`)
                  },
                })
              : null,
            can('suppliers.edit') ? button('Edit', { variant: 'outline', icon: 'edit', onClick: () => { dialog.close(); openForm(supplier) } }) : null,
            minorToNumber(supplier.balance) > 0 && can('purchases.create')
              ? button('Record payment', { variant: 'secondary', icon: 'payments', onClick: () => openPayment(supplier, render) })
              : null
          ),

          h('h3', { class: 'text-sm font-semibold text-content-muted', text: 'Purchase history' }),
          history.items.length > 0
            ? card(
                h(
                  'div',
                  { class: 'divide-y divide-border' },
                  ...history.items.map((purchase) => purchaseRow(purchase))
                )
              )
            : h('p', { class: 'text-sm text-content-subtle', text: 'Nothing bought from this supplier yet.' })
        )
      )
    }

    function purchaseRow(purchase: PurchaseRow): HTMLElement {
      return h(
        'div',
        { class: 'flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0' },
        h(
          'div',
          { class: 'min-w-0' },
          h(
            'div',
            { class: 'flex items-center gap-2' },
            h('span', { class: 'text-sm tabular-nums text-content', text: purchase.invoiceNo }),
            badge(purchase.status.replace(/_/g, ' ').toLowerCase(), { tone: purchaseTone(purchase.status) })
          ),
          h('p', {
            class: 'text-xs text-content-muted',
            text: new Date(purchase.createdAt).toLocaleDateString(),
          })
        ),
        h(
          'div',
          { class: 'shrink-0 text-right' },
          h('p', { class: 'text-sm tabular-nums text-content', text: formatMoney(purchase.total, { currency }) }),
          minorToNumber(purchase.outstanding) > 0
            ? h('p', { class: 'text-xs tabular-nums text-warning', text: `${formatMoney(purchase.outstanding, { currency })} due` })
            : null
        )
      )
    }

    try {
      await render()
    } catch (error) {
      mount(dialog.body, emptyState('Could not open the supplier', { description: translateError(error).message, iconName: 'error' }))
    }
  }

  /** Payment against the supplier as a whole; the server allocates it. */
  async function openPayment(supplier: SupplierRow, onDone: () => Promise<void>): Promise<void> {
    const methods = await loadMethods()
    const amountInput = input({ id: 'supplier-payment', inputmode: 'decimal', autofocus: true, placeholder: minorToNumber(supplier.balance).toFixed(2) })
    const methodSelect = select({
      id: 'supplier-payment-method',
      options: methods.map((method) => ({ value: method.id, label: method.name })),
      ...(methods[0] ? { value: methods[0].id } : {}),
    })
    const referenceInput = input({ id: 'supplier-payment-ref', placeholder: 'Cheque no. or note (optional)' })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const submit = button('Record payment', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({
      title: `Pay ${supplier.name}`,
      subtitle: `Outstanding ${formatMoney(supplier.balance, { currency })}. The oldest unpaid orders are settled first.`,
      iconName: 'payments',
      size: 'sm',
      footer: [h('div', { class: 'w-full' }, submit)],
    })

    mount(
      dialog.body,
      h('div', { class: 'space-y-4' }, field('Amount', amountInput, { required: true }), field('Paid with', methodSelect), field('Reference', referenceInput), errorSlot)
    )

    submit.addEventListener('click', () => {
      void (async () => {
        const amount = parseMinor(amountInput.value)
        if (amount === null || minorToNumber(amount) <= 0) {
          errorSlot.textContent = 'Enter an amount greater than zero.'
          errorSlot.classList.remove('hidden')
          return
        }
        if (!methodSelect.value) {
          errorSlot.textContent = 'Choose how it was paid.'
          errorSlot.classList.remove('hidden')
          return
        }
        submit.disabled = true
        try {
          const result = await repos.purchases.pay({
            supplierId: supplier.id,
            amount,
            methodId: methodSelect.value,
            reference: referenceInput.value.trim() || null,
          })
          dialog.close()
          toastSuccess(`Paid. ${formatMoney(result.supplierBalance, { currency })} still owed.`)
          await onDone()
        } catch (error) {
          errorSlot.textContent = translateError(error).message
          errorSlot.classList.remove('hidden')
        } finally {
          submit.disabled = false
        }
      })()
    })
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

  const toolbar = h(
    'div',
    { class: 'flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center' },
    searchBox,
    can('suppliers.create')
      ? button('Add', { variant: 'primary', icon: 'add', onClick: () => openForm(null), class: 'shrink-0' })
      : null
  )

  mount(
    root,
    h('div', { class: 'border-b border-border px-3 pt-3 pb-3' }, h('h1', { class: 'text-lg font-semibold text-content', text: 'Suppliers' })),
    summarySlot,
    toolbar,
    listSlot,
    footerSlot
  )

  void reload()
  return root
}

function purchaseTone(status: PurchaseRow['status']): 'success' | 'warning' | 'neutral' | 'danger' {
  if (status === 'RECEIVED') return 'success'
  if (status === 'PARTIALLY_RECEIVED') return 'warning'
  if (status === 'CANCELLED') return 'danger'
  return 'neutral'
}
