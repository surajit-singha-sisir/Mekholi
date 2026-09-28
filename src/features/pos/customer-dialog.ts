/**
 * Attaching a customer to the sale (spec §19).
 *
 * The cart has modelled a customer since the first commit — `Cart.customerId`,
 * `p_customer_id` on `complete_sale`, `sales.customer_id`, and a receipt that
 * prints the name — and nothing in the till ever set it. Every sale was a
 * walk-in: a shop could not say who bought what, and no add-on could be about
 * the person standing at the counter, which is why a loyalty screen could say
 * "attach a customer to award points" and no cashier could.
 *
 * So this is deliberately small, and deliberately core. A customer is a name
 * and a phone number (§19); everything else is optional. The dialog searches
 * what the shop already has, and — when the search finds nobody and the user
 * may create — offers to add exactly what was typed, because that is the moment
 * the shopkeeper has the information and the reason to write it down.
 */

import { h, icon, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { modal } from '../../components/feedback/modal'
import { input, field } from '../../components/ui/input'
import { toastError } from '../../components/feedback/toast'
import { can } from '../../app/state/session'
import { getRepositories } from '../../app/data'
import { translateError } from '../../app/platform/errors'
import { normalizePhone } from '../../shared/domain/phone'
import { formatMoney } from '../../shared/domain/money'
import type { CustomerRow } from '../../shared/types/records'
import { parseMinor } from '../../shared/domain/money'
import type { Minor } from '../../shared/domain/money'

export interface CustomerDialogOptions {
  /** Everyone on the sale now. The first is the one it is billed to. */
  selected: CustomerRow[]
  currency: string
  /**
   * Called on every tick and untick, not once at the end.
   *
   * The till behind the dialog shows the chips and unlocks the pay button, and
   * a cashier who ticks a name expects to see that happen — waiting for
   * “Done” would make the dialog feel like a form to submit rather than a list
   * to tick.
   */
  onChange: (customers: CustomerRow[]) => void
}

/**
 * What the shop typed, split into a name and a phone number when it is one.
 *
 * A phone number is digits, spaces, dashes and an optional leading `+`; a name
 * is not. Getting this wrong is how a shop ends up with a customer called
 * `01712345678` and no way to phone them.
 */
export function splitQuery(query: string): { name: string; phone: string | null } {
  const name = query.trim()
  const digits = name.replace(/[\s-]/g, '')
  const isPhone = /^\+?\d{6,15}$/.test(digits)
  if (isPhone) return { name, phone: name }
  // "Nasrin 01712 345678" — a name followed by a phone is both at once,
  // which is exactly how a counter types a new customer in one breath.
  const tail = name.match(/^(.+?)[\s,]+(\+?\d[\d\s-]{5,})$/)
  if (tail) {
    const candidate = (tail[2] ?? '').trim()
    if (/^\+?\d{6,15}$/.test(candidate.replace(/[\s-]/g, ''))) {
      return { name: (tail[1] ?? '').trim(), phone: candidate }
    }
  }
  return { name, phone: null }
}

/** The line under a name: what tells two customers apart at a glance. */
export function describe(customer: CustomerRow, currency: string): string {
  const parts: string[] = []
  if (customer.phone) parts.push(customer.phone)
  if (customer.email) parts.push(customer.email)
  const credit = parseMinor(customer.store_credit) ?? (0 as Minor)
  if (credit > 0) parts.push(`${formatMoney(credit, { currency })} in credit`)
  return parts.length > 0 ? parts.join(' · ') : 'No phone number'
}

export function openCustomerDialog(options: CustomerDialogOptions): { close: () => void } {
  const { currency, onChange } = options
  // The dialog owns a copy while it is open and hands the whole list back on
  // every change, so the till never has to merge two versions of the truth.
  let selected: CustomerRow[] = [...options.selected]
  const repos = getRepositories()

  let results: CustomerRow[] = []
  let query = ''
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const dialog = modal({
    title: 'Customers on this sale',
    subtitle: 'Tick everyone who is on it. The first is who the sale is billed to.',
    iconName: 'person_add',
    size: 'md',
    dismissible: true,
  })

  const search = input({
    type: 'search',
    placeholder: 'Search by name or phone',
    autofocus: true,
    autocomplete: 'off',
    leadingIcon: 'search',
    onInput: (value) => {
      query = value
      if (timer) clearTimeout(timer)
      // The same 200 ms the catalogue search uses: a scanner or a fast typist
      // finishes the word before the shop's database is asked anything.
      timer = setTimeout(() => void run(query), 200)
    },
    onEnter: () => {
      // Enter takes the first match, so a cashier holding a phone number never
      // reaches for the mouse.
      const first = results[0]
      if (first) toggle(first)
      else void run(query)
    },
  })

  const listBox = h('div', { class: 'space-y-1' })

  const clearButton = button('Clear', {
    size: 'sm',
    variant: 'ghost',
    icon: 'close',
    title: 'Take everyone off this sale',
    onClick: () => {
      selected = []
      onChange(selected)
      draw()
    },
  })

  const doneButton = button('Done', {
    size: 'sm',
    variant: 'primary',
    onClick: () => dialog.close(),
  })

  /**
   * Writes the count into the button.
   *
   * Never `querySelector('span')`: the first span is the icon, rendered in
   * Material Symbols, and text put there comes out as glyph soup.
   */
  function setDoneLabel(text: string): void {
    const label = doneButton.querySelector('[data-label]')
    if (label) label.textContent = text
  }
  const statusLine = h('p', { class: 'text-xs text-content-muted' })
  const busyLine = h('div', { class: 'hidden items-center gap-2 text-xs text-content-muted' })

  async function run(term: string): Promise<void> {
    busy = true
    draw()
    try {
      const page = await repos.customers.list({ search: term.trim(), limit: 20 })
      results = page.items
    } catch (error) {
      results = []
      toastError(translateError(error).message)
    } finally {
      busy = false
      draw()
    }
  }

  /** Is this person already on the sale? */
  function isSelected(id: string): boolean {
    return selected.some((row) => row.id === id)
  }

  /**
   * One row in the list: a tick box, the name, and what tells two people with
   * the same name apart.
   *
   * It does not close the dialog. A counter with a company buyer and the person
   * collecting needs two names on one sale, and reopening the dialog between
   * them turned a two-second job into a four-step one.
   */
  function resultRow(customer: CustomerRow): HTMLElement {
    const on = isSelected(customer.id)
    const billed = selected[0]?.id === customer.id
    return h('button', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': on ? 'true' : 'false',
      'data-customer-option': customer.id,
      class: [
        'w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-left',
        on ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface hover:bg-surface-muted',
      ].join(' '),
      onClick: () => toggle(customer),
    },
      h('span', {
        class: [
          'grid h-5 w-5 shrink-0 place-items-center rounded border',
          on ? 'border-primary bg-primary text-white' : 'border-border text-transparent',
        ].join(' '),
        'aria-hidden': 'true',
      }, icon('check', 'text-[15px]')),
      h('div', { class: 'min-w-0 flex-1' },
        h('p', { class: 'truncate text-sm text-content', text: customer.name }),
        h('p', { class: 'truncate text-xs text-content-muted', text: describe(customer, currency) })
      ),
      billed
        ? h('span', {
            class: 'shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary',
            text: 'billed',
          })
        : null,
      customer.balance !== '0.00'
        ? h('span', {
            class: 'shrink-0 text-xs tabular-nums text-content-muted',
            text: `owes ${formatMoney(parseMinor(customer.balance) ?? (0 as Minor), { currency })}`,
          })
        : null
    )
  }

  function draw(): void {
    const rows: HTMLElement[] = []

    // Whoever is already on the sale stays pinned to the top, in order, even
    // when the search term does not match them — otherwise typing a second
    // name hides the first and the cashier cannot tell what is ticked.
    for (const customer of selected) rows.push(resultRow(customer))
    for (const customer of results) {
      if (isSelected(customer.id)) continue
      rows.push(resultRow(customer))
    }

    // Only offered when the search came back empty: "add what I typed" beside
    // three matches is a way to create a near-duplicate of the customer the
    // shopkeeper was about to pick.
    const typed = splitQuery(query)
    if (can('customers.create') && typed.name !== '' && results.length === 0 && !busy) {
      // A phone is mandatory on a customer, so the button only exists when
      // there is one — and the hint says exactly what to type instead of
      // letting the tap fail afterwards.
      if (typed.phone && normalizePhone(typed.phone)) {
        rows.push(
          button(`Add “${typed.name}”`, {
            size: 'sm',
            variant: 'secondary',
            icon: 'person_add',
            fullWidth: true,
            onClick: () => void create(typed.name, typed.phone),
          })
        )
      } else {
        rows.push(
          h('p', {
            class: 'rounded-md bg-surface-muted px-3 py-2 text-xs text-content-muted',
            text: `To add “${typed.name}”, type the phone after the name — “${typed.name} 01712345678”. A customer needs a phone number.`,
          })
        )
      }
    }

    mount(listBox, ...rows)
    statusLine.textContent = busy
      ? ''
      : selected.length > 0
        ? `${selected.length} on this sale`
        : results.length === 0
          ? 'Nobody matches yet — type a name and phone to add a customer.'
          : `${results.length} match${results.length === 1 ? '' : 'es'}`
    busyLine.classList.toggle('hidden', !busy)
    clearButton.classList.toggle('hidden', selected.length === 0)
    setDoneLabel(selected.length === 0 ? 'Done' : `Done · ${selected.length}`)
  }

  async function create(name: string, phone: string | null): Promise<void> {
    const normal = phone ? normalizePhone(phone) : null
    if (!normal) {
      toastError('A customer needs a phone number — e.g. 01712345678.')
      return
    }
    busy = true
    draw()
    try {
      const created = await repos.customers.create({ name, phone: normal })
      // A customer written down at the counter is one the cashier meant to put
      // on the sale, so it is ticked rather than merely listed.
      busy = false
      selected = [...selected, created]
      onChange(selected)
      query = ''
      search.value = ''
      await run('')
    } catch (error) {
      toastError(translateError(error).message)
      busy = false
      draw()
    }
  }

  function toggle(customer: CustomerRow): void {
    selected = isSelected(customer.id)
      ? selected.filter((row) => row.id !== customer.id)
      : [...selected, customer]
    onChange(selected)
    draw()
  }

  busyLine.append(spinner('h-3 w-3'), h('span', { text: 'Looking…' }))

  dialog.body.append(
    field('Find the customer', search),
    h('div', { class: 'mt-3 max-h-[46vh] overflow-y-auto pr-0.5 space-y-1' }, busyLine, listBox),
    h('div', { class: 'mt-2 flex items-center justify-between gap-2' },
      statusLine,
      h('div', { class: 'flex items-center gap-2' }, clearButton, doneButton)
    )
  )

  void run('')

  return { close: dialog.close }
}
