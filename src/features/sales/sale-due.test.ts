/**
 * The Sales screen's "Due" must read the same as the due book (`app.sale_due`,
 * migration 057). These pin the rule that a refunded or cancelled sale owes
 * nothing — the bug that made /sales show a larger due than /plugins/due-ledger.
 */
import { describe, it, expect } from 'vitest'
import { DUE_BEARING_STATUSES, saleDue } from './sale-due'

describe('saleDue', () => {
  it('owes the unpaid remainder on a part-paid sale', () => {
    expect(saleDue('PARTIALLY_PAID', 450, 0)).toBe(450)
    expect(saleDue('PARTIALLY_PAID', 450, 200)).toBe(250)
  })

  it('owes nothing on a completed sale that was paid in full', () => {
    expect(saleDue('COMPLETED', 900, 900)).toBe(0)
  })

  it('still owes the remainder when a sale is only partially refunded', () => {
    expect(saleDue('PARTIALLY_REFUNDED', 510, 0)).toBe(510)
  })

  it('owes nothing on a fully refunded sale, however the columns read', () => {
    // This is the fix: total 450, paid 0 would naively look like a 450 due.
    expect(saleDue('REFUNDED', 450, 0)).toBe(0)
  })

  it('owes nothing on a cancelled hold', () => {
    expect(saleDue('CANCELLED', 900, 0)).toBe(0)
    expect(saleDue('DRAFT', 100, 0)).toBe(0)
    expect(saleDue('HELD', 100, 0)).toBe(0)
  })

  it('never returns a negative due when a customer overpaid', () => {
    expect(saleDue('COMPLETED', 100, 120)).toBe(0)
  })

  it('counts exactly the three statuses the ledger books a due for', () => {
    expect([...DUE_BEARING_STATUSES].sort()).toEqual([
      'COMPLETED',
      'PARTIALLY_PAID',
      'PARTIALLY_REFUNDED',
    ])
  })
})
