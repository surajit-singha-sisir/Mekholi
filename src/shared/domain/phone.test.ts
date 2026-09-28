import { describe, expect, it } from 'vitest'
import { normalizePhone } from './phone'

describe('normalizePhone', () => {
  it('accepts every way a BD mobile is written and dials it as 01…', () => {
    expect(normalizePhone('01712345678')).toBe('01712345678')
    expect(normalizePhone('+880 1712-345678')).toBe('01712345678')
    expect(normalizePhone('8801712345678')).toBe('01712345678')
    expect(normalizePhone('1712345678')).toBe('01712345678')
    expect(normalizePhone(' 01712 345 678 ')).toBe('01712345678')
  })

  it('lets a sane foreign number through untouched', () => {
    expect(normalizePhone('+97144001234')).toBe('+97144001234')
    expect(normalizePhone('442071234567')).toBe('442071234567')
  })

  it('refuses what no phone can be', () => {
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone('Nadia')).toBeNull()
    expect(normalizePhone('12345')).toBeNull() // five digits is a typo
    expect(normalizePhone('01712-ABCDEF')).toBeNull()
    expect(normalizePhone('1234567890123456')).toBeNull() // sixteen digits is not a phone
  })
})
