import { describe, expect, it } from 'vitest'
import {
  buildLabelSheet,
  countLabels,
  customLabelSize,
  labelSize,
  LABEL_SIZES,
  type LabelItem,
} from './sheet'

const rice: LabelItem = { name: 'Miniket Rice 5kg', sku: 'RICE-5KG', price: '৳450.00', copies: 3 }

describe('buildLabelSheet', () => {
  it('prints every copy of every label, in order', () => {
    const html = buildLabelSheet([rice, { ...rice, name: 'Sugar', sku: 'SUG-1', copies: 2 }],
      labelSize('a4-50x25'), { shopName: 'Rahim Store', showPrice: true })
    expect(html.match(/class="label"/g)).toHaveLength(5)
    expect(html).toContain('Rahim Store')
    expect(html).toContain('৳450.00')
    expect(html).toContain('<svg')
  })

  it('skips a SKU no barcode can carry rather than printing a broken label', () => {
    const html = buildLabelSheet([{ ...rice, sku: 'চাল-৫' }, rice], labelSize('a4-50x25'), {
      shopName: '',
      showPrice: false,
    })
    expect(html.match(/class="label"/g)).toHaveLength(3)
  })

  it('a roll prints one label per page; a sheet flows and wraps', () => {
    const roll = buildLabelSheet([rice], labelSize('roll-40x30'), { shopName: '', showPrice: true })
    expect(roll).toContain('page-break-after: always')
    expect(roll).toContain('size: 40mm 30mm')

    const sheet = buildLabelSheet([rice], labelSize('a4-38x21'), { shopName: '', showPrice: true })
    expect(sheet).toContain('size: A4')
    expect(sheet).toContain('flex-wrap: wrap')
  })

  it('escapes a product name that carries markup', () => {
    const html = buildLabelSheet([{ ...rice, name: '<b>Rice</b> & "Dal"' }], labelSize('a4-50x25'), {
      shopName: '',
      showPrice: false,
    })
    expect(html).toContain('&lt;b&gt;Rice&lt;/b&gt; &amp; &quot;Dal&quot;')
  })

  it('falls back to the first size for an unknown id', () => {
    expect(labelSize('nonsense').id).toBe(LABEL_SIZES[0]?.id)
  })

  it('a partly used A4 sheet starts after the missing stickers', () => {
    const html = buildLabelSheet([{ ...rice, copies: 1 }], labelSize('a4-50x25'), {
      shopName: '', showPrice: false, skipCells: 7,
    })
    expect(html.match(/class="label blank"/g)).toHaveLength(7)
    expect(html.match(/class="label"/g)).toHaveLength(1)
    // A roll has no cells to skip; the option is ignored, never a blank page.
    const roll = buildLabelSheet([{ ...rice, copies: 1 }], labelSize('roll-40x30'), {
      shopName: '', showPrice: false, skipCells: 7,
    })
    expect(roll).not.toContain('label blank')
  })

  it('says exactly what it is told to say — MRP, note, date, no name', () => {
    const html = buildLabelSheet([{ ...rice, copies: 1 }], labelSize('roll-58x40'), {
      shopName: 'Rahim Store',
      showPrice: true,
      showName: false,
      mrp: true,
      noteLine: '01711-000000',
      packedDate: 'Packed: 28 Sep 2026',
    })
    expect(html).toContain('MRP ৳450.00')
    expect(html).toContain('01711-000000')
    expect(html).toContain('Packed: 28 Sep 2026')
    expect(html).not.toContain('Miniket Rice 5kg')
  })

  it('one text-size knob scales every line together', () => {
    const large = buildLabelSheet([{ ...rice, copies: 1 }], labelSize('roll-40x30'), {
      shopName: '', showPrice: true, fontScale: 1.2,
    })
    expect(large).toContain('font-size: 7.8pt') // name: 6.5 × 1.2
    expect(large).toContain('font-size: 9.6pt') // price: 8 × 1.2
    const normal = buildLabelSheet([{ ...rice, copies: 1 }], labelSize('roll-40x30'), {
      shopName: '', showPrice: true,
    })
    expect(normal).toContain('font-size: 6.5pt')
  })

  it('a custom size is clamped to what a barcode can survive', () => {
    const size = customLabelSize(10, 300, 'roll')
    expect(size.widthMm).toBe(20)
    expect(size.heightMm).toBe(150)
    const html = buildLabelSheet([{ ...rice, copies: 1 }], customLabelSize(45, 22, 'roll'), {
      shopName: '', showPrice: true,
    })
    expect(html).toContain('size: 45mm 22mm')
  })
})

describe('countLabels', () => {
  it('counts copies and ignores the unencodable', () => {
    expect(countLabels([rice, { ...rice, sku: '৫কেজি', copies: 10 }])).toBe(3)
    expect(countLabels([{ ...rice, copies: 0 }])).toBe(1)
  })
})
