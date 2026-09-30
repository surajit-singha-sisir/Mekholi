import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { lineTotalOf } from './purchases-view'
import { formatMoney, milli, minor, type Milli, type Minor } from '../../shared/domain/money'

describe('purchase order line total (scale)', () => {
  it('keeps minor-unit scale: 10 × ৳2,450.00 is ৳24,500.00, not ৳245.00', () => {
    // 245000 minor = ৳2,450.00 ; 10000 milli = 10 units.
    const line = {
      variantId: 'v1',
      name: 'HP 65W USB-C Laptop Charger',
      qty: milli(10000) as Milli,
      unitCost: minor(245000) as Minor,
    }
    const total = lineTotalOf(line)
    expect(total).toBe(2_450_000)
    expect(formatMoney(total, { symbol: false, digits: 'latin' })).toBe('24,500.00')
  })

  it('handles fractional quantities without collapsing the scale', () => {
    // 2.5 units × ৳100.00 = ৳250.00
    const line = {
      variantId: 'v2',
      name: 'Cable (per metre)',
      qty: milli(2500) as Milli,
      unitCost: minor(10000) as Minor,
    }
    expect(formatMoney(lineTotalOf(line), { symbol: false, digits: 'latin' })).toBe('250.00')
  })
})

describe('purchase order product picker', () => {
  it('settles with the selected product before modal close reports cancellation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/purchases/purchases-view.ts'), 'utf8')
    const handler = source.slice(source.indexOf('// Resolve the selected product before closing'), source.indexOf('// Resolve the selected product before closing') + 500)

    expect(handler.indexOf('finish({ product })')).toBeGreaterThan(-1)
    expect(handler.indexOf('dialog.close()')).toBeGreaterThan(handler.indexOf('finish({ product })'))
  })
})
