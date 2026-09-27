import { describe, expect, it } from 'vitest'
import { buildLabelSheet, countLabels, labelSize, LABEL_SIZES, type LabelItem } from './sheet'

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
})

describe('countLabels', () => {
  it('counts copies and ignores the unencodable', () => {
    expect(countLabels([rice, { ...rice, sku: '৫কেজি', copies: 10 }])).toBe(3)
    expect(countLabels([{ ...rice, copies: 0 }])).toBe(1)
  })
})
