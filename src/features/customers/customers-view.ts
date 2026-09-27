/**
 * Customers (spec §19 — the remaining half of the Phase 2 residue).
 *
 * Name and phone are the only required fields, and the list is built to be
 * used with a customer standing at the counter: search by either, tap, see the
 * two numbers that matter — what they owe, and what store credit they hold.
 *
 * Store credit is shown here because Phase 4 creates it: a refund taken as
 * credit is only useful if the shop can then see it, and only honest if the
 * customer can be shown the same figure.
 */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { card, emptyState } from '../../components/ui/card'
import { input, field, searchInput, select } from '../../components/ui/input'
import { dataTable } from '../../components/ui/table'
import { exportToolbar, sortReportRows } from '../../components/ui/table-tools'
import { modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization, can } from '../../app/state/session'
import { formatMoney, minor, minorToNumber, parseMinor, type Minor } from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { CustomerRow } from '../../shared/types/records'
import type { ReportCell, ReportColumn } from '../../shared/repositories/contracts'

/**
 * `CustomerRow` carries money as the raw numeric strings Postgres sends
 * ("150.00" — major units). `parseMinor` is the honest conversion; the old
 * `toMinor(Number(...))` read major as minor and was off by 100× — invisible
 * only while nothing ever wrote a balance.
 */
function asMinor(value: string): Minor {
  return parseMinor(value) ?? minor(0)
}

/** The customer book's columns — the screen, the CSV, the picture and the
 * printout all render exactly these, in this order (§23). */
export const CUSTOMER_COLUMNS: readonly ReportColumn[] = [
  { key: 'name', label: 'Customer', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'due', label: 'Due', type: 'money', align: 'right' },
  { key: 'store_credit', label: 'Store credit', type: 'money', align: 'right' },
  { key: 'credit_limit', label: 'Credit limit', type: 'money', align: 'right' },
  { key: 'added', label: 'Added', type: 'date' },
]

export interface CustomersViewOptions {
  onNavigate?: (path: string) => void
  /**
   * True while the shop keeps a due book (the due-ledger plugin is
   * loaded). Off, the "Collect due" button is not offered — what the
   * customer owes is still *shown*, because a fact on the books does not
   * stop being true when the workflow around it is switched off.
   */
  collectDue?: boolean
}

export function customersView(options: CustomersViewOptions = {}): HTMLElement {
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'

  let search = ''
  let rows: CustomerRow[] = []
  let cursor: string | null = null
  let loading = false
  let sortKey: string | undefined
  let sortDir: 'asc' | 'desc' = 'asc'

  /** One customer as the table (and every export) sees it. */
  function toReportRow(row: CustomerRow): Record<string, ReportCell> {
    const limit = Number(asMinor(row.credit_limit))
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      due: Number(asMinor(row.balance)),
      store_credit: Number(asMinor(row.store_credit)),
      credit_limit: limit > 0 ? limit : null,
      added: row.created_at,
    }
  }

  function visibleRows(): Record<string, ReportCell>[] {
    const mapped = rows.map(toReportRow)
    return sortKey ? sortReportRows(CUSTOMER_COLUMNS, mapped, sortKey, sortDir) : mapped
  }

  const root = h('div', { class: 'flex w-full min-w-0 flex-col' })
  const listSlot = h('div', { class: 'p-3' })
  const footerSlot = h('div', { class: 'border-t border-border p-3' })

  const searchBox = searchInput('Search by name or phone…', (value) => {
    search = value
    void reload()
  })

  async function reload(): Promise<void> {
    if (loading) return
    loading = true
    cursor = null
    mount(listSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    try {
      const page = await repos.customers.list({ limit: 30, ...(search.trim() ? { search } : {}) })
      rows = page.items
      cursor = page.nextCursor
      render()
    } catch (error) {
      mount(listSlot, emptyState('Customers could not be loaded', { description: translateError(error).message, iconName: 'error' }))
    } finally {
      loading = false
      renderFooter()
    }
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loading) return
    loading = true
    try {
      const page = await repos.customers.list({ limit: 30, cursor, ...(search.trim() ? { search } : {}) })
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
        emptyState('No customers yet', {
          description: 'Add someone when they want a receipt in their name, owe you money, or hold store credit.',
          iconName: 'group',
          ...(can('customers.create') ? { action: button('Add customer', { variant: 'primary', icon: 'person_add', onClick: () => openForm(null) }) } : {}),
        })
      )
      return
    }

    const visible = visibleRows()
    const totalDue = visible.reduce((sum, row) => sum + Number(row['due'] ?? 0), 0)
    const totalCredit = visible.reduce((sum, row) => sum + Number(row['store_credit'] ?? 0), 0)

    const toolbar = exportToolbar({
      title: 'Customers',
      filename: 'customers',
      columns: CUSTOMER_COLUMNS,
      currency,
      rows: () => visibleRows(),
      subtitle: () =>
        `${visible.length} customer${visible.length === 1 ? '' : 's'} · ` +
        `${formatMoney(minor(totalDue), { currency, digits: 'latin', convert: false })} due · ` +
        `${formatMoney(minor(totalCredit), { currency, digits: 'latin', convert: false })} store credit`,
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
            columns: CUSTOMER_COLUMNS,
            rows: visible,
            totals: { due: totalDue, store_credit: totalCredit },
            currency,
            sort: sortKey,
            dir: sortDir,
            onSort: (key) => {
              if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
              else {
                sortKey = key
                // Money opens big-first; names and dates open A-first/oldest-first.
                sortDir = CUSTOMER_COLUMNS.find((c) => c.key === key)?.type === 'money' ? 'desc' : 'asc'
              }
              render()
            },
            onRowClick: (reportRow) => {
              const original = rows.find((row) => row.id === reportRow['id'])
              if (original) void openDetail(original)
            },
            pageSize: 50,
            emptyTitle: 'No customers yet',
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
        h('p', { class: 'text-xs text-content-subtle', text: `${rows.length} customer${rows.length === 1 ? '' : 's'}${cursor ? ' · more' : ''}` }),
        cursor ? button('Load more', { variant: 'outline', onClick: () => void loadMore() }) : null
      )
    )
  }

  function openForm(existing: CustomerRow | null): void {
    const nameInput = input({ id: 'customer-name', value: existing?.name ?? '', autofocus: true, placeholder: 'Nadia Begum' })
    const phoneInput = input({ id: 'customer-phone', value: existing?.phone ?? '', inputmode: 'tel', placeholder: '01XXXXXXXXX' })
    const emailInput = input({ id: 'customer-email', type: 'email', value: existing?.email ?? '' })
    const addressInput = input({ id: 'customer-address', value: existing?.address ?? '' })
    const noteInput = input({ id: 'customer-note', value: existing?.note ?? '' })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const submit = button(existing ? 'Save changes' : 'Add customer', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({
      title: existing ? 'Edit customer' : 'New customer',
      subtitle: 'Name and phone are enough — everything else can wait.',
      iconName: 'person_add',
      size: 'sm',
      footer: [h('div', { class: 'w-full' }, submit)],
    })

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        field('Name', nameInput, { required: true }),
        field('Phone', phoneInput),
        field('Email', emailInput),
        field('Address', addressInput),
        field('Note', noteInput),
        errorSlot
      )
    )

    submit.addEventListener('click', () => {
      void (async () => {
        const name = nameInput.value.trim()
        if (!name) {
          errorSlot.textContent = 'A customer needs a name.'
          errorSlot.classList.remove('hidden')
          return
        }
        submit.disabled = true
        try {
          const draft = {
            name,
            phone: phoneInput.value.trim() || null,
            email: emailInput.value.trim() || null,
            address: addressInput.value.trim() || null,
            note: noteInput.value.trim() || null,
          }
          if (existing) await repos.customers.update(existing.id, draft)
          else await repos.customers.create(draft)
          dialog.close()
          toastSuccess(existing ? 'Customer updated' : 'Customer added')
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
   * The collection half of the khata: money in against what the customer
   * owes. The amount opens pre-filled with the full due because "cleared it
   * all" is the common case; a part payment is one edit. Allocation to
   * invoices (oldest first) is the server's job — the dialog only asks the
   * three questions a shopkeeper actually has: how much, how, any slip
   * number.
   */
  async function openCollect(customer: CustomerRow): Promise<void> {
    const owed = asMinor(customer.balance)

    let methods
    try {
      methods = await repos.catalog.listPaymentMethods()
    } catch (error) {
      toastError(translateError(error).message)
      return
    }
    if (methods.length === 0) {
      toastError('This shop has no payment methods configured.')
      return
    }

    const amountInput = input({
      id: 'collect-amount',
      type: 'text',
      inputmode: 'decimal',
      value: (minorToNumber(owed) / 100).toFixed(2),
    })
    const methodSelect = select({
      id: 'collect-method',
      value: methods[0]!.id,
      options: methods.map((m) => ({ value: m.id, label: m.name })),
    })
    const referenceInput = input({ id: 'collect-reference', placeholder: 'Receipt or transaction no. (optional)' })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const submit = button('Collect', {
      variant: 'primary',
      fullWidth: true,
      size: 'lg',
      icon: 'payments',
      onClick: () => void submitCollect(),
    })

    const dialog = modal({
      title: `Collect from ${customer.name}`,
      subtitle: `Owes ${formatMoney(owed, { currency })}`,
      iconName: 'payments',
      size: 'sm',
      footer: [h('div', { class: 'w-full' }, submit)],
    })

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        field('Amount received', amountInput, { required: true }),
        field('Paid by', methodSelect),
        field('Reference', referenceInput),
        errorSlot
      )
    )
    amountInput.focus()
    amountInput.select()

    function showError(message: string): void {
      errorSlot.textContent = message
      errorSlot.classList.remove('hidden')
    }

    async function submitCollect(): Promise<void> {
      const amount = parseMinor(amountInput.value)
      if (amount === null || minorToNumber(amount) <= 0) {
        showError('Enter the amount received.')
        return
      }
      if (minorToNumber(amount) > minorToNumber(owed)) {
        // The server refuses this too; saying it here saves a round trip.
        showError(`That is more than the ${formatMoney(owed, { currency })} owed. Money held for later belongs in store credit, not the due book.`)
        return
      }
      submit.disabled = true
      try {
        const result = await repos.customers.collectPayment({
          customerId: customer.id,
          amount,
          methodId: methodSelect.value,
          reference: referenceInput.value.trim() || null,
        })
        dialog.close()
        toastSuccess(
          minorToNumber(result.balance) > 0
            ? `Collected ${formatMoney(amount, { currency })} — ${formatMoney(result.balance, { currency })} still due.`
            : `Collected ${formatMoney(amount, { currency })} — all settled.`
        )
        void reload()
      } catch (error) {
        submit.disabled = false
        showError(translateError(error).message)
      }
    }
  }

  async function openDetail(row: CustomerRow): Promise<void> {
    const dialog = modal({ title: row.name, size: 'md', iconName: 'group' })
    mount(dialog.body, h('div', { class: 'flex justify-center p-6' }, spinner()))

    try {
      const [customer, history] = await Promise.all([
        repos.customers.get(row.id),
        repos.sales.byCustomer(row.id, { limit: 10 }),
      ])
      const current = customer ?? row

      mount(
        dialog.body,
        h(
          'div',
          { class: 'space-y-4' },
          h(
            'div',
            { class: 'grid grid-cols-2 gap-3' },
            h(
              'div',
              { class: 'rounded-lg border border-border p-3' },
              h('p', { class: 'text-xs text-content-muted', text: 'Owes' }),
              h('p', { class: 'text-lg font-semibold tabular-nums text-content', text: formatMoney(asMinor(current.balance), { currency }) })
            ),
            h(
              'div',
              { class: 'rounded-lg border border-border p-3' },
              h('p', { class: 'text-xs text-content-muted', text: 'Store credit' }),
              h('p', { class: 'text-lg font-semibold tabular-nums text-success', text: formatMoney(asMinor(current.store_credit), { currency }) })
            )
          ),
          h('p', { class: 'text-sm text-content-muted', text: [current.phone, current.email, current.address].filter(Boolean).join(' · ') || 'No contact details' }),
          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            options.collectDue && minorToNumber(asMinor(current.balance)) > 0 && can('sales.create')
              ? button('Collect due', { variant: 'primary', icon: 'payments', onClick: () => { dialog.close(); void openCollect(current) } })
              : null,
            can('customers.edit') ? button('Edit', { variant: 'outline', icon: 'edit', onClick: () => { dialog.close(); openForm(current) } }) : null,
            can('sales.view') ? button('Their sales', { variant: 'secondary', icon: 'receipt_long', onClick: () => { dialog.close(); options.onNavigate?.('/sales') } }) : null
          ),
          h('h3', { class: 'text-sm font-semibold text-content-muted', text: 'Recent purchases' }),
          history.items.length > 0
            ? card(
                h(
                  'div',
                  { class: 'divide-y divide-border' },
                  ...history.items.map((sale) =>
                    h(
                      'div',
                      { class: 'flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0' },
                      h(
                        'div',
                        { class: 'min-w-0' },
                        h('p', { class: 'text-sm tabular-nums text-content', text: sale.invoice_no }),
                        h('p', { class: 'text-xs text-content-muted', text: new Date(sale.created_at).toLocaleDateString() })
                      ),
                      h('div', { class: 'shrink-0 text-right' },
                        h('p', { class: 'text-sm tabular-nums text-content', text: formatMoney(asMinor(sale.total), { currency }) }),
                        sale.status !== 'COMPLETED'
                          ? h('p', { class: 'text-xs text-content-muted', text: sale.status.replace(/_/g, ' ').toLowerCase() })
                          : null
                      )
                    )
                  )
                )
              )
            : h('p', { class: 'text-sm text-content-subtle', text: 'No purchases recorded against this customer yet.' })
        )
      )
    } catch (error) {
      mount(dialog.body, emptyState('Could not open the customer', { description: translateError(error).message, iconName: 'error' }))
    }
  }

  mount(
    root,
    h(
      'div',
      { class: 'flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center' },
      searchBox,
      can('customers.create') ? button('Add', { variant: 'primary', icon: 'person_add', onClick: () => openForm(null), class: 'shrink-0' }) : null
    ),
    listSlot,
    footerSlot
  )

  void reload()
  return root
}
