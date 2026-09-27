import { describe, expect, it } from 'vitest'
import {
  buildProductsCsv,
  buildProductsCsvTemplate,
  parseProductsCsv,
  PRODUCT_CSV_COLUMNS,
} from './product-csv'
import type { ProductRow } from '../../shared/types/records'

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'p1',
    organization_id: 'org',
    name: 'Miniket Rice 5kg',
    sku: 'RICE-5KG',
    description: null,
    category_id: 'c1',
    brand_id: null,
    unit_id: 'u1',
    tax_id: null,
    selling_price: '450.00',
    cost_price: '410.0000',
    tax_inclusive: false,
    reorder_point: '10.000',
    track_stock: true,
    allow_negative: false,
    is_active: true,
    image_url: null,
    metadata: {},
    created_at: '2026-09-27T00:00:00Z',
    ...overrides,
  }
}

const names = {
  categories: { c1: 'Grocery' },
  brands: { b1: 'ACI' },
  units: { u1: 'kg' },
}

describe('buildProductsCsv', () => {
  it('writes names, not ids, and survives commas in a product name', () => {
    const csv = buildProductsCsv(
      [product({ name: 'Rice, red (5kg)' })],
      names
    )
    expect(csv).toContain('"Rice, red (5kg)"')
    expect(csv).toContain('Grocery')
    expect(csv).not.toContain('c1')
  })

  it('round-trips through the importer with identical values', () => {
    const csv = buildProductsCsv(
      [
        product(),
        product({
          id: 'p2',
          name: 'Loose "Deshi" Sugar',
          sku: null,
          category_id: null,
          unit_id: null,
          selling_price: '95.50',
          tax_inclusive: true,
          allow_negative: true,
        }),
      ],
      names
    )
    const { rows, errors } = parseProductsCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      name: 'Miniket Rice 5kg',
      sku: 'RICE-5KG',
      category: 'Grocery',
      unit: 'kg',
      selling_price: 450,
      cost_price: 410,
      reorder_point: 10,
      track_stock: true,
    })
    expect(rows[1]).toMatchObject({
      name: 'Loose "Deshi" Sugar',
      sku: null,
      category: null,
      selling_price: 95.5,
      tax_inclusive: true,
      allow_negative: true,
    })
  })
})

describe('parseProductsCsv', () => {
  it('accepts key-style headers and mixed-case labels', () => {
    const csv = 'name,SELLING_PRICE\nCandle,25\n'
    const { rows, errors } = parseProductsCsv(csv)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ name: 'Candle', selling_price: 25 })
  })

  it('applies defaults for omitted columns', () => {
    const csv = 'Name,Selling price\nCandle,25\n'
    const { rows } = parseProductsCsv(csv)
    expect(rows[0]).toMatchObject({
      cost_price: 0,
      tax_inclusive: false,
      reorder_point: 0,
      track_stock: true,
      allow_negative: false,
      is_active: true,
    })
  })

  it('reports a broken row with its file line number and keeps the rest', () => {
    const csv = 'Name,Selling price\nGood,10\n,20\nBad price,abc\nAlso good,30\n'
    const { rows, errors } = parseProductsCsv(csv)
    expect(rows.map((row) => row.name)).toEqual(['Good', 'Also good'])
    expect(errors).toEqual([
      { line: 3, message: 'Missing a product name.' },
      { line: 4, message: '"Bad price": the selling price is not a number.' },
    ])
  })

  it('refuses a duplicate SKU inside the same file', () => {
    const csv = 'Name,SKU,Selling price\nA,X-1,10\nB,x-1,20\n'
    const { rows, errors } = parseProductsCsv(csv)
    expect(rows).toHaveLength(1)
    expect(errors[0]?.message).toContain('already appears on line 2')
  })

  it('tolerates thousands separators and blank spreadsheet rows', () => {
    const csv = 'Name,Selling price\nTV,"1,250.50"\n,,\n'
    const { rows, errors } = parseProductsCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.selling_price).toBe(1250.5)
  })

  it('rejects a file without the two required headers', () => {
    const { rows, errors } = parseProductsCsv('Title,Price\nA,1\n')
    expect(rows).toEqual([])
    expect(errors[0]?.line).toBe(1)
    expect(errors[0]?.message).toContain('Name')
  })

  it('rejects a boolean that is neither true nor false', () => {
    const csv = 'Name,Selling price,Track stock\nA,10,maybe\n'
    const { rows, errors } = parseProductsCsv(csv)
    expect(rows).toEqual([])
    expect(errors[0]?.message).toContain('track stock')
  })

  it('parses the template it publishes', () => {
    const { rows, errors } = parseProductsCsv(buildProductsCsvTemplate())
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Miniket Rice 5kg')
  })

  it('keeps the column list stable — the template and the parser agree', () => {
    const labels = PRODUCT_CSV_COLUMNS.map((column) => column.label)
    expect(labels[0]).toBe('Name')
    expect(labels).toContain('Selling price')
  })
})
