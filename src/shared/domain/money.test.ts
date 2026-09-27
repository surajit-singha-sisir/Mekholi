/**
 * Money and quantity arithmetic.
 *
 * The interesting cases are the ones a float implementation gets wrong:
 * `0.1 + 0.2`, rounding a half, lakh digit grouping, and a decimal quantity
 * arriving from a barcode scale as `1.250`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  convertToDisplayMinor,
  displayConversion,
  resetDisplayConversionProvider,
  setDisplayConversionProvider,
  type DisplayConversion,
  formatMoney,
  formatQty,
  groupIndian,
  minor,
  minorToFixed,
  milli,
  parseMilli,
  parseMinor,
  roundHalfAway,
  type Minor,
} from './money'

describe('roundHalfAway', () => {
  it('rounds halves away from zero, like Postgres round(numeric)', () => {
    expect(roundHalfAway(2.5)).toBe(3)
    expect(roundHalfAway(3.5)).toBe(4)
    expect(roundHalfAway(-2.5)).toBe(-3)
    expect(roundHalfAway(-3.5)).toBe(-4)
    expect(roundHalfAway(0.5)).toBe(1)
    expect(roundHalfAway(-0.5)).toBe(-1)
  })

  it('rounds ordinary values normally', () => {
    expect(roundHalfAway(2.4)).toBe(2)
    expect(roundHalfAway(2.6)).toBe(3)
    expect(roundHalfAway(-2.4)).toBe(-2)
    expect(roundHalfAway(0)).toBe(0)
  })

  it('survives the binary representation of decimal halves', () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754, so a naive Math.round
    // returns 100 and the customer is shortchanged a paisa.
    expect(roundHalfAway(1.005 * 100)).toBe(101)
    expect(roundHalfAway(8.835 * 100)).toBe(884)
  })

  it('returns 0 for non-finite input rather than NaN', () => {
    expect(roundHalfAway(Number.NaN)).toBe(0)
    expect(roundHalfAway(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('parseMinor', () => {
  it('parses plain numbers and text', () => {
    expect(parseMinor('1250.00')).toBe(125000)
    expect(parseMinor(1250)).toBe(125000)
    expect(parseMinor('0.05')).toBe(5)
    expect(parseMinor(0)).toBe(0)
  })

  it('strips currency symbols, grouping and whitespace', () => {
    expect(parseMinor(' ৳ 1,250.50 ')).toBe(125050)
    expect(parseMinor('৳1250')).toBe(125000)
    expect(parseMinor('$12.99')).toBe(1299)
  })

  it('rejects anything that is not an amount', () => {
    expect(parseMinor('')).toBeNull()
    expect(parseMinor('abc')).toBeNull()
    expect(parseMinor('-')).toBeNull()
    expect(parseMinor('.')).toBeNull()
    expect(parseMinor(null)).toBeNull()
    expect(parseMinor(undefined)).toBeNull()
    expect(parseMinor(Number.NaN)).toBeNull()
  })

  it('rounds sub-paisa input instead of truncating it', () => {
    expect(parseMinor('0.005')).toBe(1)
    expect(parseMinor('0.004')).toBe(0)
  })
})

describe('parseMilli', () => {
  it('keeps three decimals for weight units', () => {
    expect(parseMilli('1.250', { decimal: true })).toBe(1250)
    expect(parseMilli('0.5', { decimal: true })).toBe(500)
    expect(parseMilli('2.375', { decimal: true })).toBe(2375)
  })

  it('forces whole units for countable goods', () => {
    // A shop selling phones must not be able to sell 0.5 of one.
    expect(parseMilli('1.5')).toBe(1000)
    expect(parseMilli('2.9')).toBe(2000)
    expect(parseMilli('3')).toBe(3000)
  })

  it('rejects empty and non-numeric input', () => {
    expect(parseMilli('')).toBeNull()
    expect(parseMilli('kg')).toBeNull()
    expect(parseMilli(null)).toBeNull()
  })
})

describe('groupIndian', () => {
  it('groups in the lakh/crore style a Bangladeshi shop expects', () => {
    expect(groupIndian(0)).toBe('0')
    expect(groupIndian(999)).toBe('999')
    expect(groupIndian(1000)).toBe('1,000')
    expect(groupIndian(12345)).toBe('12,345')
    expect(groupIndian(100000)).toBe('1,00,000')
    expect(groupIndian(1234567)).toBe('12,34,567')
    expect(groupIndian(10000000)).toBe('1,00,00,000')
  })
})

describe('formatMoney', () => {
  it('renders minor units with two decimals and a symbol', () => {
    expect(formatMoney(minor(0))).toBe('৳\u202f0.00')
    expect(formatMoney(minor(5))).toBe('৳\u202f0.05')
    expect(formatMoney(minor(125000))).toBe('৳\u202f1,250.00')
    expect(formatMoney(minor(10000000))).toBe('৳\u202f1,00,000.00')
  })

  it('shows negatives with a leading minus, not a bracket', () => {
    expect(formatMoney(minor(-125000))).toBe('-৳\u202f1,250.00')
  })

  it('omits the symbol when asked', () => {
    expect(formatMoney(minor(125000), { symbol: false })).toBe('1,250.00')
  })

  it('uses the right symbol for other currencies', () => {
    expect(formatMoney(minor(1000), { currency: 'USD' })).toBe('$\u202f10.00')
    expect(formatMoney(minor(1000), { currency: 'INR' })).toBe('₹\u202f10.00')
  })
})

describe('minorToFixed', () => {
  it('never uses exponent notation and always keeps two decimals', () => {
    expect(minorToFixed(minor(0))).toBe('0.00')
    expect(minorToFixed(minor(7))).toBe('0.07')
    expect(minorToFixed(minor(-7))).toBe('-0.07')
    expect(minorToFixed(minor(100000000))).toBe('1000000.00')
  })
})

describe('formatQty', () => {
  it('collapses whole weights and keeps fractional ones', () => {
    expect(formatQty(milli(3000), { decimal: true })).toBe('3')
    expect(formatQty(milli(1250), { decimal: true })).toBe('1.25')
    expect(formatQty(milli(1500), { decimal: true, unitLabel: 'kg' })).toBe('1.5\u202fkg')
  })

  it('rounds to a whole number for countable units', () => {
    expect(formatQty(milli(3000))).toBe('3')
    expect(formatQty(milli(3000), { unitLabel: 'ea' })).toBe('3\u202fea')
  })
})

describe('brand separation', () => {
  it('keeps money and quantity in different types', () => {
    const price: Minor = minor(25000)
    const qty = milli(3000)
    // This line exists to be a compile error if the brands are ever removed:
    // money and quantity must not be interchangeable.
    expect(price * qty).toBe(75000000)
  })
})

// ── Display conversion (multi-currency plugin seam) ───────────────────────

const usd = (rate: number): DisplayConversion => ({ code: 'USD', decimals: 2, rate })

describe('display conversion', () => {
  afterEach(() => resetDisplayConversionProvider())

  it('is off until someone pushes a provider — money formats as before', () => {
    expect(displayConversion()).toBeNull()
    expect(formatMoney(minor(140000), { digits: 'latin' })).toContain('1,400.00')
  })

  it('converts the shop’s own example: ৳1,400 at 1 USD = 122.50 BDT', () => {
    setDisplayConversionProvider(() => usd(122.5))
    // 1400 / 122.5 = 11.4285… → $11.43, rounded once, half away from zero.
    expect(formatMoney(minor(140000), { currency: 'BDT', digits: 'latin' })).toBe('$\u202f11.43')
  })

  it('keeps the sign and rounds like Postgres on refund lines', () => {
    setDisplayConversionProvider(() => usd(122.5))
    expect(formatMoney(minor(-140000), { currency: 'BDT', digits: 'latin' })).toBe('-$\u202f11.43')
  })

  it('respects the display currency’s own decimals — yen has none', () => {
    setDisplayConversionProvider(() => ({ code: 'JPY', decimals: 0, rate: 0.85 }))
    // 1400 / 0.85 = 1647.05… → ¥1,647, no decimal point at all.
    expect(formatMoney(minor(140000), { currency: 'BDT', digits: 'latin' })).toBe('¥\u202f1,647')
  })

  it('stays out of machine-bound output when the caller says convert: false', () => {
    setDisplayConversionProvider(() => usd(122.5))
    expect(formatMoney(minor(140000), { digits: 'latin', convert: false })).toBe('৳\u202f1,400.00')
  })

  it('refuses a rate that cannot survive a division', () => {
    setDisplayConversionProvider(() => usd(0))
    expect(formatMoney(minor(140000), { digits: 'latin' })).toBe('৳\u202f1,400.00')
    setDisplayConversionProvider(() => usd(Number.NaN))
    expect(formatMoney(minor(140000), { digits: 'latin' })).toBe('৳\u202f1,400.00')
  })

  it('does nothing when display and base are the same currency', () => {
    setDisplayConversionProvider(() => ({ code: 'BDT', decimals: 2, rate: 1 }))
    expect(formatMoney(minor(140000), { currency: 'BDT', digits: 'latin' })).toBe('৳\u202f1,400.00')
  })

  it('exposes the raw arithmetic for screens that explain themselves', () => {
    expect(convertToDisplayMinor(minor(140000), usd(122.5))).toBe(1143)
    expect(convertToDisplayMinor(minor(140000), { code: 'KWD', decimals: 3, rate: 400 })).toBe(3500)
  })
})
