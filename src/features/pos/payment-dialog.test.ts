/**
 * Taking the money.
 *
 * Two faults shipped together and produced the screenshot that started this:
 *
 *   1. The dialog re-labelled its primary button with
 *      `submitButton.querySelector('span')`, which finds the *icon* span when
 *      the button has an icon. \"Still owed ৳900.00\" was being written into a
 *      Material Symbols element and drawn as glyph soup across the real label.
 *   2. The button was disabled until a tender had been added, and the only way
 *      to add one was the Enter key. On a ৳900.00 sale with ৳900.00 already
 *      typed into the amount field, a touch-screen cashier had no way forward.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openPaymentDialog } from './payment-dialog'
import { minor } from '../../shared/domain/money'
import type { PaymentMethod } from '../../shared/types/records'

const CASH = { id: 'm-1', key: 'CASH', name: 'Cash', icon: 'payments' } as unknown as PaymentMethod
const CARD = { id: 'm-2', key: 'CARD', name: 'Card', icon: 'credit_card' } as unknown as PaymentMethod

const submitButton = (): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.className.includes('w-full')
  )!

const label = (): string => submitButton().querySelector('[data-label]')!.textContent ?? ''

const amountBox = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('input[inputmode=decimal]')!

const type = (value: string): void => {
  const box = amountBox()
  box.value = value
  box.dispatchEvent(new Event('input', { bubbles: true }))
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => document.body.replaceChildren())
afterEach(() => document.body.replaceChildren())

describe('the button that takes the money', () => {
  it('writes its label into the label, not into the icon', async () => {
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined })
    await settle()

    const icon = submitButton().querySelector('.material-symbols-rounded, [class*=material-symbols]')
    // The icon is still an icon — the only thing an icon font can render.
    expect(icon?.textContent).toBe('check_circle')
    expect(label()).not.toContain('Still owed')
  })

  it('offers to complete the sale when the pre-filled amount already covers it', async () => {
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined })
    await settle()

    // The field opens pre-filled with the balance. That is a payable sale.
    expect(amountBox().value).toBe('900.00')
    expect(label()).toBe('Complete sale')
    expect(submitButton().disabled).toBe(false)
  })

  it('completes the sale on a click, with no keyboard anywhere', async () => {
    const onSubmit = vi.fn()
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit })
    await settle()

    submitButton().click()
    await settle()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toEqual([
      { methodId: 'm-1', methodKey: 'CASH', methodName: 'Cash', amount: 90000 },
    ])
  })

  it('names the change before the cashier commits to it', async () => {
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined })
    await settle()

    type('1000')
    expect(label()).toBe('Complete · change 100.00')
  })

  it('offers a part payment as a part payment, not as a dead end', async () => {
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined })
    await settle()

    type('500')
    expect(label()).toBe('Add 500.00 · 400.00 left')
    expect(submitButton().disabled).toBe(false)
  })

  it('takes a split payment entirely by click', async () => {
    const onSubmit = vi.fn()
    openPaymentDialog({ total: minor(90000), methods: [CASH, CARD], currency: 'BDT', onSubmit })
    await settle()

    type('500')
    submitButton().click()
    await settle()
    expect(onSubmit).not.toHaveBeenCalled()

    // The rest on a card.
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Card'))!
      .click()
    type('400')
    submitButton().click()
    await settle()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toHaveLength(2)
  })

  it('shows what went wrong instead of [object Object]', async () => {
    // A PostgREST failure is a plain object, not an Error, so the old
    // `String(error)` fallback printed `[object Object]` under the Reference
    // field — the cashier was told a sale had failed and not told why.
    const onSubmit = vi.fn().mockRejectedValue({
      code: '42703',
      message: 'column sale_payments_1.created_at does not exist',
    })
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit })
    await settle()

    submitButton().click()
    await settle()

    const shown = document.body.textContent ?? ''
    expect(shown).not.toContain('[object Object]')
    expect(shown).toContain('column sale_payments_1.created_at does not exist')
  })

  it('says what is owed, and refuses, when the field is empty', async () => {
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined })
    await settle()

    type('')
    expect(label()).toBe('Still owed 900.00')
    expect(submitButton().disabled).toBe(true)
  })
})

describe('the khata path — keep the rest as due', () => {
  const dueButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('as due') || (b.textContent ?? '').includes('Nothing left to owe')
    )

  it('is not offered on an anonymous sale', async () => {
    // The server refuses a due with no name (credit_sale_needs_customer),
    // so the dialog must not dangle a button that can only end in an error.
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined })
    await settle()

    expect(dueButton()).toBeUndefined()
  })

  it('books the whole total as due when nothing has been tendered', async () => {
    const onDue = vi.fn()
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined, onDue })
    await settle()

    expect(dueButton()!.textContent).toContain('Keep 900.00 as due')
    dueButton()!.click()
    await settle()

    // Zero tenders is the classic khata sale: goods leave, the book remembers.
    expect(onDue).toHaveBeenCalledWith([])
  })

  it('banks the part payment and books only the remainder', async () => {
    const onDue = vi.fn()
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit: () => undefined, onDue })
    await settle()

    type('400')
    submitButton().click() // not settled yet, so this adds the tender
    await settle()

    expect(dueButton()!.textContent).toContain('Keep 500.00 as due')
    dueButton()!.click()
    await settle()

    const payments = onDue.mock.calls[0]![0] as { methodId: string; amount: number }[]
    expect(payments).toHaveLength(1)
    expect(payments[0]!.methodId).toBe('m-1')
    expect(payments[0]!.amount).toBe(40000)
  })

  it('lets the exact-payment fast path win — full payment books no due', async () => {
    // An exact tender auto-settles the sale (the overwhelmingly common
    // case); the khata button must not intercept a sale that owes nothing.
    const onDue = vi.fn()
    const onSubmit = vi.fn()
    openPaymentDialog({ total: minor(90000), methods: [CASH], currency: 'BDT', onSubmit, onDue })
    await settle()

    type('900')
    submitButton().click() // adds the exact tender, which settles and submits
    await settle()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onDue).not.toHaveBeenCalled()
  })
})
