/**
 * Product CSV import/export (spec §9 method 4 — the Phase 2 residue P2-1).
 *
 * A shop migrating from another POS arrives with its catalogue in a
 * spreadsheet, and typing four hundred products into a form is the week that
 * makes it give up. This module is the round trip: export writes a file a
 * spreadsheet opens cleanly, import reads the same file back — including the
 * one the export wrote, which is what the tests assert.
 *
 * The module is pure: text in, rows and errors out. It never touches a
 * repository, so it runs in Node under vitest with no browser and no network.
 * The view resolves names to ids (category, brand, unit) because only the
 * view has the lookups — and because "Rice" meaning category id `7f3a…` is a
 * fact about one shop, not about the file format.
 *
 * Errors carry the file's own line number, because "row 3 is broken" sends a
 * shopkeeper counting rows in Excel — which shows line numbers, not row
 * indexes, and whose first line is the header.
 */

import { toCsv, parseCsv, type CsvColumn } from '../../shared/export/csv'
import type { ProductRow } from '../../shared/types/records'

/** One parsed data row, names still names — the view maps them to ids. */
export interface ProductCsvRow {
  /** 1-based line in the file, header included: the number Excel shows. */
  line: number
  name: string
  sku: string | null
  description: string | null
  /** Category/brand/unit arrive as names; blank means none. */
  category: string | null
  brand: string | null
  unit: string | null
  selling_price: number
  cost_price: number
  tax_inclusive: boolean
  reorder_point: number
  track_stock: boolean
  allow_negative: boolean
  is_active: boolean
  image_url: string | null
}

export interface ProductCsvError {
  line: number
  message: string
}

export interface ProductCsvParse {
  rows: ProductCsvRow[]
  errors: ProductCsvError[]
}

/**
 * The columns, in file order. `label` is what the header row says; import
 * also accepts the key itself, so a hand-made file with `selling_price` in
 * the header works as well as one that says "Selling price".
 */
export const PRODUCT_CSV_COLUMNS: readonly CsvColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'sku', label: 'SKU' },
  { key: 'description', label: 'Description' },
  { key: 'category', label: 'Category' },
  { key: 'brand', label: 'Brand' },
  { key: 'unit', label: 'Unit' },
  { key: 'selling_price', label: 'Selling price' },
  { key: 'cost_price', label: 'Cost price' },
  { key: 'tax_inclusive', label: 'Tax inclusive' },
  { key: 'reorder_point', label: 'Reorder point' },
  { key: 'track_stock', label: 'Track stock' },
  { key: 'allow_negative', label: 'Allow negative stock' },
  { key: 'is_active', label: 'Active' },
  { key: 'image_url', label: 'Image URL' },
]

/** Id → display-name lookups the exporter needs to write names, not UUIDs. */
export interface ProductCsvNames {
  categories: Record<string, string>
  brands: Record<string, string>
  units: Record<string, string>
}

/** The whole catalogue as CSV text, names resolved, BOM for Excel. */
export function buildProductsCsv(
  products: readonly ProductRow[],
  names: ProductCsvNames
): string {
  const rows = products.map((product) => ({
    name: product.name,
    sku: product.sku ?? '',
    description: product.description ?? '',
    category: product.category_id ? (names.categories[product.category_id] ?? '') : '',
    brand: product.brand_id ? (names.brands[product.brand_id] ?? '') : '',
    unit: product.unit_id ? (names.units[product.unit_id] ?? '') : '',
    // Prices are stored as numeric strings ("125.50"); they pass through as
    // written so the export never re-rounds what the database holds.
    selling_price: product.selling_price,
    cost_price: product.cost_price,
    tax_inclusive: product.tax_inclusive ? 'true' : 'false',
    reorder_point: product.reorder_point,
    track_stock: product.track_stock ? 'true' : 'false',
    allow_negative: product.allow_negative ? 'true' : 'false',
    is_active: product.is_active ? 'true' : 'false',
    image_url: product.image_url ?? '',
  }))
  return toCsv(PRODUCT_CSV_COLUMNS, rows, { bom: true })
}

/** A one-example-row file for the "where do I start" moment. */
export function buildProductsCsvTemplate(): string {
  return toCsv(
    PRODUCT_CSV_COLUMNS,
    [
      {
        name: 'Miniket Rice 5kg',
        sku: 'RICE-5KG',
        description: '',
        category: 'Grocery',
        brand: '',
        unit: 'kg',
        selling_price: '450',
        cost_price: '410',
        tax_inclusive: 'false',
        reorder_point: '10',
        track_stock: 'true',
        allow_negative: 'false',
        is_active: 'true',
        image_url: '',
      },
    ],
    { bom: true }
  )
}

// ── Import ────────────────────────────────────────────────────────────────

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'n', '0'])

function parseBool(raw: string, fallback: boolean): boolean | null {
  const word = raw.trim().toLowerCase()
  if (word === '') return fallback
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return null
}

/** "1,250.50" and "1250.5" both mean the same price; "abc" means an error. */
function parseAmount(raw: string, fallback: number): number | null {
  const cleaned = raw.trim().replace(/,/g, '')
  if (cleaned === '') return fallback
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

function blankToNull(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Maps the header line to column indexes. Labels are matched
 * case-insensitively, and the key form (`selling_price`) is accepted too.
 * Unknown columns are ignored rather than refused — a file exported from
 * another POS carries columns this app has no use for, and refusing the whole
 * file over "Discount %" helps nobody.
 */
function headerIndex(header: readonly string[]): Record<string, number> {
  const wanted = new Map<string, string>()
  for (const column of PRODUCT_CSV_COLUMNS) {
    wanted.set(column.label.toLowerCase(), column.key)
    wanted.set(column.key.toLowerCase(), column.key)
  }
  const index: Record<string, number> = {}
  header.forEach((cell, position) => {
    const key = wanted.get(cell.trim().toLowerCase())
    if (key && !(key in index)) index[key] = position
  })
  return index
}

/**
 * CSV text → rows and errors. A broken row is reported and skipped; the rest
 * of the file still imports. All-or-nothing would make one typo in row 371
 * cost the whole afternoon again.
 */
export function parseProductsCsv(text: string): ProductCsvParse {
  const table = parseCsv(text)
  const errors: ProductCsvError[] = []
  const rows: ProductCsvRow[] = []

  if (table.length === 0) {
    return { rows, errors: [{ line: 1, message: 'The file is empty.' }] }
  }

  const index = headerIndex(table[0] as string[])
  if (index['name'] === undefined || index['selling_price'] === undefined) {
    return {
      rows,
      errors: [
        {
          line: 1,
          message:
            'The header must include at least "Name" and "Selling price". ' +
            'Download the template to see the expected columns.',
        },
      ],
    }
  }

  const cell = (row: readonly string[], key: string): string => {
    const position = index[key]
    return position === undefined ? '' : (row[position] ?? '')
  }

  const seenSkus = new Map<string, number>()

  for (let i = 1; i < table.length; i += 1) {
    const raw = table[i] as string[]
    const line = i + 1
    // A row of nothing but empty cells is a spreadsheet artefact, not data.
    if (raw.every((value) => value.trim() === '')) continue

    const name = cell(raw, 'name').trim()
    if (!name) {
      errors.push({ line, message: 'Missing a product name.' })
      continue
    }

    const sellingPrice = parseAmount(cell(raw, 'selling_price'), NaN)
    if (sellingPrice === null || Number.isNaN(sellingPrice)) {
      errors.push({ line, message: `"${name}": the selling price is not a number.` })
      continue
    }
    const costPrice = parseAmount(cell(raw, 'cost_price'), 0)
    if (costPrice === null) {
      errors.push({ line, message: `"${name}": the cost price is not a number.` })
      continue
    }
    const reorderPoint = parseAmount(cell(raw, 'reorder_point'), 0)
    if (reorderPoint === null) {
      errors.push({ line, message: `"${name}": the reorder point is not a number.` })
      continue
    }

    const flags = {
      tax_inclusive: parseBool(cell(raw, 'tax_inclusive'), false),
      track_stock: parseBool(cell(raw, 'track_stock'), true),
      allow_negative: parseBool(cell(raw, 'allow_negative'), false),
      is_active: parseBool(cell(raw, 'is_active'), true),
    }
    const badFlag = (Object.entries(flags) as [string, boolean | null][]).find(
      ([, value]) => value === null
    )
    if (badFlag) {
      errors.push({
        line,
        message: `"${name}": ${badFlag[0].replace(/_/g, ' ')} must be true or false.`,
      })
      continue
    }

    const sku = blankToNull(cell(raw, 'sku'))
    if (sku) {
      const already = seenSkus.get(sku.toLowerCase())
      if (already !== undefined) {
        errors.push({
          line,
          message: `"${name}": SKU ${sku} already appears on line ${already}.`,
        })
        continue
      }
      seenSkus.set(sku.toLowerCase(), line)
    }

    rows.push({
      line,
      name,
      sku,
      description: blankToNull(cell(raw, 'description')),
      category: blankToNull(cell(raw, 'category')),
      brand: blankToNull(cell(raw, 'brand')),
      unit: blankToNull(cell(raw, 'unit')),
      selling_price: sellingPrice,
      cost_price: costPrice,
      tax_inclusive: flags.tax_inclusive as boolean,
      reorder_point: reorderPoint,
      track_stock: flags.track_stock as boolean,
      allow_negative: flags.allow_negative as boolean,
      is_active: flags.is_active as boolean,
      image_url: blankToNull(cell(raw, 'image_url')),
    })
  }

  return { rows, errors }
}
