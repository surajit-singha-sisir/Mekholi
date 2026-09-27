/**
 * The payment dialog (spec §15, §16).
 *
 * Built for the common case first: a cash sale for the exact total should take
 * one keystroke. The amount field opens pre-filled with what is owed, so Enter
 * settles it. Split payment is available but never in the way — the cashier
 * adds a second tender only when there is one.
 *
 * Cash shortcuts (500 / 1000 / exact) exist because counting change is the
 * slowest part of a cash sale, and a shop that types `1000` for every note
 * will not use the software for long.
 */

import { h } from '../../components/ui/h'
import { button, iconButton } from '../../components/ui/button'
import { input, field } from '../../components/ui/input'
import { modal } from '../../components/feedback/modal'
import { badge } from '../../components/ui/card'
import {
  balanceDue,
  settlement,
  suggestNotes,
  type PaymentEntry,
} from '../../shared/domain/cart'
import { formatMoney, minor, parseMinor, type Minor } from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { PaymentMethod } from '../../shared/types/records'

export interface PaymentDialogOptions {
  total: Minor
  methods: PaymentMethod[]
  currency: string
  onSubmit: (payments: PaymentEntry[]) => Promise<void> | void
  /**
   * The khata path: complete the sale with whatever has been tendered — even
   * nothing — and book the remainder against the customer. Offered only when
   * a customer is on the sale, because the database refuses a due with no
   * name (`credit_sale_needs_customer`, migration 057).
   */
  onDue?: ((payments: PaymentEntry[]) => Promise<void> | void) | undefined
}

export function openPaymentDialog(options: PaymentDialogOptions): { close: () => void } {
  const { total, methods, currency, onSubmit, onDue } = options

  const [firstMethod] = methods
  const payments: PaymentEntry[] = []

  const dialog = modal({
    title: 'Take payment',
    subtitle: `Total due ${formatMoney(total, { currency })}`,
    iconName: 'payments',
    size: 'md',
    dismissible: true,
  })

  const dueLabel = h('p', {
    class: 'text-3xl font-semibold text-content tabular-nums tracking-tight',
    text: formatMoney(total, { currency }),
  })

  const changeLabel = h('p', { class: 'text-sm text-content-muted mt-1' })
  const errorSlot = h('p', { class: 'text-sm text-danger mt-2 hidden', role: 'alert' })

  const amountInput = input({
    type: 'text',
    inputmode: 'decimal',
    value: (total / 100).toFixed(2),
    autofocus: true,
    onInput: () => refresh(),
    onEnter: () => void addTender(),
  })

  const referenceInput = input({
    type: 'text',
    placeholder: 'Reference (bKash trxid, last 4 of card) — optional',
    onEnter: () => void addTender(),
  })

  let selectedMethodId = firstMethod?.id ?? ''
  let selectedMethod: PaymentMethod | undefined = firstMethod

  /**
   * Rebuilt on every selection change rather than patched in place. Rewriting
   * Tailwind class strings with `replace` to fake a selected state is how a
   * button ends up wearing two variants at once.
   */
  const methodRow = h('div', { class: 'flex flex-wrap gap-1.5' })

  function renderMethods(): void {
    methodRow.replaceChildren(
      ...methods.map((method) =>
        button(method.name, {
          variant: method.id === selectedMethodId ? 'primary' : 'outline',
          size: 'sm',
          ...(method.icon ? { icon: method.icon } : {}),
          onClick: () => {
            selectedMethodId = method.id
            selectedMethod = method
            renderMethods()
            amountInput.focus()
          },
        })
      )
    )
  }
  renderMethods()

  const tenderList = h('ul', { class: 'space-y-1.5' })
  const noteHint = h('div', { class: 'mt-2' })

  function refresh(): void {
    const due = balanceDue(total, payments)
    dueLabel.textContent = formatMoney(due, { currency })
    const result = settlement(total, payments)
    if (payments.length === 0) {
      changeLabel.textContent = `Total ${formatMoney(total, { currency })}`
      noteHint.replaceChildren()
    } else if (result.settled) {
      changeLabel.textContent = result.change > 0
        ? `Change due ${formatMoney(result.change, { currency })}`
        : 'Paid exactly — no change'
      const notes = suggestNotes(result.change)
      noteHint.replaceChildren(
        ...notes.map((note) =>
          badge(`${note.count} × ${formatMoney(note.denomination, { currency, symbol: false })}`, {
            tone: 'neutral',
            class: 'mr-1',
          })
        )
      )
    } else {
      changeLabel.textContent = `Still owed ${formatMoney(due, { currency })}`
      noteHint.replaceChildren()
    }

    renderTenders()

    // What the amount field is offering right now. The tender is not added
    // until the cashier acts, but the button has to describe the *outcome* of
    // acting — otherwise a till showing a pre-filled ৳900.00 against a ৳900.00
    // total presents a disabled button reading "Still owed ৳900.00", which is
    // both untrue and a dead end for anyone without a keyboard.
    const typed = parseMinor(amountInput.value) ?? minor(0)
    const offered = typed > 0 && selectedMethod ? typed : minor(0)
    const willSettle = !result.settled && offered >= due
    const change = result.settled ? result.change : minor(offered - due)

    submitButton.disabled = submitting || (!result.settled && offered <= 0)
    setSubmitLabel(
      result.settled || willSettle
        ? change > 0
          ? `Complete · change ${formatMoney(change, { currency, symbol: false })}`
          : 'Complete sale'
        : offered > 0
          ? `Add ${formatMoney(offered, { currency, symbol: false })} · ` +
            `${formatMoney(minor(due - offered), { currency, symbol: false })} left`
          : `Still owed ${formatMoney(due, { currency, symbol: false })}`
    )

    // The khata button describes what it will book, and disappears into
    // irrelevance (disabled) the moment the tenders cover the total.
    if (dueButton) {
      dueButton.disabled = submitting || result.settled
      dueButton.querySelector('[data-label]')!.textContent = result.settled
        ? 'Nothing left to owe'
        : `Keep ${formatMoney(due, { currency, symbol: false })} as due`
    }
  }

  /**
   * Writes the button's text, never its icon. `querySelector('span')` finds
   * the icon first, and an icon font renders a price as nonsense.
   */
  function setSubmitLabel(text: string): void {
    submitButton.querySelector('[data-label]')!.textContent = text
  }

  function renderTenders(): void {
    tenderList.replaceChildren(
      ...payments.map((payment, index) =>
        h(
          'li',
          { class: 'flex items-center justify-between gap-2 text-sm' },
          h('span', { class: 'text-content-muted', text: payment.methodName }),
          payment.reference
            ? h('span', { class: 'text-xs text-content-subtle', text: payment.reference })
            : null,
          h('span', { class: 'font-medium text-content tabular-nums', text: formatMoney(payment.amount, { currency }) }),
          iconButton('close', 'Remove', {
            size: 'sm',
            variant: 'ghost',
            onClick: () => {
              payments.splice(index, 1)
              refresh()
            },
          })
        )
      )
    )
  }

  let submitting = false

  async function addTender(): Promise<void> {
    errorSlot.classList.add('hidden')
    if (!selectedMethod) {
      showError('Choose a payment method first.')
      return
    }
    const parsed = parseMinor(amountInput.value)
    if (parsed === null || parsed <= 0) {
      showError('Enter an amount greater than zero.')
      return
    }
    const due = balanceDue(total, payments)
    const reference = referenceInput.value.trim()

    payments.push({
      methodId: selectedMethod.id,
      methodKey: selectedMethod.key,
      methodName: selectedMethod.name,
      amount: parsed,
      ...(reference ? { reference } : {}),
    })

    amountInput.value = '0.00'
    referenceInput.value = ''
    refresh()

    // One tender for the exact remaining balance settles the sale, which is
    // the overwhelmingly common case — so settle it without another click.
    const remaining = balanceDue(total, payments)
    if (remaining === 0 && parsed >= due) {
      await submit()
    }
  }

  function showError(message: string): void {
    errorSlot.textContent = message
    errorSlot.classList.remove('hidden')
  }

  const submitButton = button('Complete sale', {
    variant: 'primary',
    size: 'lg',
    fullWidth: true,
    icon: 'check_circle',
    // The one button does the one obvious thing: whatever is in the amount
    // field becomes a tender, and a tender that covers the balance settles
    // the sale — the same path Enter takes, reachable by thumb.
    onClick: () => {
      if (settlement(total, payments).settled) void submit()
      else void addTender()
    },
  })

  async function submit(): Promise<void> {
    if (submitting) return
    const result = settlement(total, payments)
    if (!result.settled) {
      showError('The payment does not cover the total yet.')
      return
    }
    submitting = true
    submitButton.disabled = true
    try {
      await onSubmit([...payments])
      dialog.close()
    } catch (error) {
      submitting = false
      submitButton.disabled = false
      // `String(error)` on a PostgREST failure renders `[object Object]`:
      // these are plain objects with `code`/`message`/`details`, not Errors.
      showError(translateError(error).message)
    }
  }

  /**
   * The khata submit: whatever has been tendered is banked, the rest is
   * written in the customer's name. A tender typed but not yet added is
   * ignored here for the same reason submit ignores it — the book records
   * money received, not money hovering over the drawer.
   */
  async function submitDue(): Promise<void> {
    if (submitting || !onDue || !dueButton) return
    if (settlement(total, payments).settled) return
    submitting = true
    dueButton.disabled = true
    submitButton.disabled = true
    try {
      await onDue([...payments])
      dialog.close()
    } catch (error) {
      submitting = false
      submitButton.disabled = false
      dueButton.disabled = false
      showError(translateError(error).message)
    }
  }

  const dueButton = onDue
    ? button('Keep as due', {
        variant: 'outline',
        fullWidth: true,
        icon: 'menu_book',
        onClick: () => void submitDue(),
      })
    : null

  const exactButton = button('Exact', {
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      amountInput.value = (balanceDue(total, payments) / 100).toFixed(2)
      amountInput.focus()
    },
  })

  const cashShortcutRow = h(
    'div',
    { class: 'flex flex-wrap gap-1.5' },
    exactButton,
    ...[500, 1000, 5000].map((value) =>
      button(String(value), {
        size: 'sm',
        variant: 'outline',
        onClick: () => {
          amountInput.value = String(value)
          amountInput.focus()
        },
      })
    )
  )

  dialog.body.replaceChildren(
    h('div', { class: 'space-y-4' },
      h('div', {}, dueLabel, changeLabel),

      payments.length > 0
        ? h('div', { class: 'border-t border-border pt-3' },
            h('p', { class: 'text-xs font-medium text-content-muted mb-1.5', text: 'Tendered' }),
            tenderList
          )
        : null,

      methodRow,

      field('Amount received', amountInput, { required: true }),
      cashShortcutRow,
      referenceInput,
      noteHint,
      errorSlot,
      submitButton,
      dueButton,

      h('p', {
        class: 'text-xs text-content-subtle text-center',
        text: 'Enter adds the tender · Esc closes',
      })
    )
  )

  refresh()
  return { close: dialog.close }
}

/** Convenience for callers that only need the minor-unit amount of a note. */
export function noteAmount(taka: number): Minor {
  return minor(taka * 100)
}
