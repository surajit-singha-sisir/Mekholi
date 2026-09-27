import { describe, expect, it } from 'vitest'
import {
  CODE128_PATTERNS,
  code128Encodable,
  code128Svg,
  code128Values,
  code128Widths,
} from './code128'

describe('the pattern table', () => {
  it('has 107 patterns, each summing to 11 modules (13 for the stop)', () => {
    // One mistyped digit in the table is one product the shop can never
    // scan, so the whole table is arithmetic-checked rather than trusted.
    expect(CODE128_PATTERNS).toHaveLength(107)
    CODE128_PATTERNS.forEach((pattern, value) => {
      const sum = [...pattern].reduce((total, digit) => total + Number(digit), 0)
      expect(sum, `pattern ${value}`).toBe(value === 106 ? 13 : 11)
    })
  })
})

describe('code128Values', () => {
  it('encodes text in set B with the documented checksum', () => {
    // "AB": start B (104), A=33, B=34; checksum (104 + 33·1 + 34·2) mod 103 = 102.
    expect(code128Values('AB')).toEqual([104, 33, 34, 102, 106])
  })

  it('packs even-length digits as set C pairs', () => {
    // "1234": start C (105), 12, 34; checksum (105 + 12·1 + 34·2) mod 103 = 82.
    expect(code128Values('1234')).toEqual([105, 12, 34, 82, 106])
  })

  it('leaves odd-length digits in set B rather than padding them', () => {
    const values = code128Values('123')
    expect(values[0]).toBe(104)
    expect(values).toHaveLength(1 + 3 + 1 + 1)
  })

  it('refuses what a scanner could never read back', () => {
    expect(() => code128Values('')).toThrow()
    expect(() => code128Values('চাল')).toThrow()
    expect(code128Encodable('RICE-5KG')).toBe(true)
    expect(code128Encodable('৫কেজি')).toBe(false)
  })
})

describe('code128Widths', () => {
  it('starts with the start pattern and ends with the stop pattern', () => {
    const widths = code128Widths('AB')
    expect(widths.slice(0, 6)).toEqual([2, 1, 1, 2, 1, 4]) // 211214 — start B
    expect(widths.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]) // 2331112 — stop
  })

  it('always spans a multiple of 11 modules plus the 13-module stop', () => {
    for (const text of ['A', 'RICE-5KG', '00123456', 'x']) {
      const total = code128Widths(text).reduce((sum, width) => sum + width, 0)
      expect((total - 13) % 11, text).toBe(0)
    }
  })
})

describe('code128Svg', () => {
  it('draws bars, a quiet zone and the human-readable line', () => {
    const svg = code128Svg('RICE-5KG')
    expect(svg).toContain('<svg')
    expect(svg).toContain('RICE-5KG</text>')
    expect(svg).toContain('aria-label="RICE-5KG"')
    // Quiet zone: the first bar must not start at x=0.
    expect(svg).not.toContain('<rect x="0" y="0"')
  })

  it('can omit the text line for the smallest labels', () => {
    expect(code128Svg('X1', { showText: false })).not.toContain('<text')
  })

  it('escapes markup-significant characters in the label', () => {
    const svg = code128Svg('A<B>&"')
    expect(svg).toContain('A&lt;B&gt;&amp;&quot;')
  })
})
