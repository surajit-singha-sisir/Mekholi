/**
 * The branch stock summary's counting rules.
 *
 * `stock_summary` is an organization-wide RPC; a branch is a subset of
 * warehouses it does not take, so the branch figures are derived on the client.
 * The rules must match `toStockRow` so the cards and the rows never disagree,
 * which is exactly what these cases pin.
 */

import { describe, it, expect } from 'vitest'
import { summariseBranchBalances, type BranchBalanceInput } from './index'

const row = (over: Partial<BranchBalanceInput>): BranchBalanceInput => ({
  quantity: 0,
  avgUnitCost: 0,
  reorderPoint: 0,
  trackStock: true,
  ...over,
})

describe('summariseBranchBalances', () => {
  it('sums value as quantity × average cost across the branch', () => {
    const totals = summariseBranchBalances([
      row({ quantity: 5, avgUnitCost: 450 }),
      row({ quantity: 2, avgUnitCost: 100 }),
    ])
    expect(totals.stockValueRaw).toBe(5 * 450 + 2 * 100)
  })

  it('counts a variant as in stock only when it has a positive quantity', () => {
    const totals = summariseBranchBalances([
      row({ quantity: 3 }),
      row({ quantity: 0 }),
      row({ quantity: -1 }),
    ])
    expect(totals.variantsInStock).toBe(1)
  })

  it('flags low as tracked, above zero and at or below the reorder point', () => {
    const totals = summariseBranchBalances([
      row({ quantity: 2, reorderPoint: 5 }), // low
      row({ quantity: 5, reorderPoint: 5 }), // low (at the point)
      row({ quantity: 6, reorderPoint: 5 }), // healthy
      row({ quantity: 0, reorderPoint: 5 }), // out, not low
    ])
    expect(totals.lowStock).toBe(2)
  })

  it('flags out as tracked and at or below zero', () => {
    const totals = summariseBranchBalances([
      row({ quantity: 0 }),
      row({ quantity: -2 }),
      row({ quantity: 1 }),
    ])
    expect(totals.outOfStock).toBe(2)
  })

  it('never counts an untracked product as low or out, however its quantity reads', () => {
    const totals = summariseBranchBalances([
      row({ quantity: 0, trackStock: false }),
      row({ quantity: 1, reorderPoint: 9, trackStock: false }),
    ])
    expect(totals.lowStock).toBe(0)
    expect(totals.outOfStock).toBe(0)
  })

  it('is all zeros for an empty branch', () => {
    expect(summariseBranchBalances([])).toEqual({
      stockValueRaw: 0,
      variantsInStock: 0,
      lowStock: 0,
      outOfStock: 0,
    })
  })
})
