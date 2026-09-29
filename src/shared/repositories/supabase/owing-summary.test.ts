/**
 * The branch receivable/payable counting rules.
 *
 * `customers.balance` and `suppliers.balance` are organization-wide running
 * totals with no branch dimension, so the branch dashboard derives what is
 * owed from the branch's own invoices instead. These cases pin the arithmetic:
 * a line owes only when billed exceeds paid, and a party with several open
 * bills is still one party.
 */

import { describe, it, expect } from 'vitest'
import { summariseOwing, type OwingInput } from './index'

const row = (over: Partial<OwingInput>): OwingInput => ({
  total: 0,
  paidTotal: 0,
  partyId: null,
  ...over,
})

describe('summariseOwing', () => {
  it('sums only what is still owed on each bill', () => {
    const totals = summariseOwing([
      row({ total: 1000, paidTotal: 400 }), // owes 600
      row({ total: 500, paidTotal: 500 }), // settled, owes nothing
      row({ total: 250, paidTotal: 0 }), // owes 250
    ])
    expect(totals.amountRaw).toBe(850)
  })

  it('never lets an overpaid bill subtract from the total', () => {
    const totals = summariseOwing([
      row({ total: 1000, paidTotal: 1200 }), // credit, not a debt owed to us
      row({ total: 300, paidTotal: 100 }), // owes 200
    ])
    expect(totals.amountRaw).toBe(200)
  })

  it('counts distinct parties, so several open bills are still one debtor', () => {
    const totals = summariseOwing([
      row({ total: 100, paidTotal: 0, partyId: 'karim' }),
      row({ total: 200, paidTotal: 0, partyId: 'karim' }),
      row({ total: 50, paidTotal: 0, partyId: 'rahima' }),
    ])
    expect(totals.parties).toBe(2)
  })

  it('adds a walk-in debt to the money but not to the party count', () => {
    const totals = summariseOwing([row({ total: 100, paidTotal: 0, partyId: null })])
    expect(totals.amountRaw).toBe(100)
    expect(totals.parties).toBe(0)
  })

  it('is all zeros for a branch with no open bills', () => {
    expect(summariseOwing([])).toEqual({ amountRaw: 0, parties: 0 })
  })
})
