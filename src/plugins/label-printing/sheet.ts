/**
 * The printable sheet: labels in, one self-contained HTML document out.
 *
 * Pure string building, no DOM — the document is written into a blank print
 * window (the same path reports print through), and a pure function can be
 * tested for the two things that actually go wrong on paper: a label split
 * across two pages, and a barcode of a SKU that was never encodable.
 *
 * Sizes are stated in millimetres because that is the unit on the label
 * packet the shop bought. The A4 sizes match the sticker sheets sold in
 * every computer-market stationery stall; the roll sizes match the two
 * label rolls thermal printers here ship with.
 */

import { code128Encodable, code128Svg } from './code128'

export interface LabelItem {
  name: string
  /** What the barcode carries. The label is pointless without it. */
  sku: string
  /** Already formatted with the currency sign, or null to omit. */
  price: string | null
  copies: number
}

export interface LabelSize {
  id: string
  label: string
  widthMm: number
  heightMm: number
  /** `a4` flows labels onto sticker sheets; `roll` is one label per page. */
  page: 'a4' | 'roll'
  /** The 21mm label has no room for a text line under the bars. */
  showText: boolean
}

export const LABEL_SIZES: readonly LabelSize[] = [
  {
    id: 'a4-38x21',
    label: 'A4 sheet — 38 × 21 mm (65 per sheet)',
    widthMm: 38,
    heightMm: 21.2,
    page: 'a4',
    showText: false,
  },
  {
    id: 'a4-50x25',
    label: 'A4 sheet — 50 × 25 mm (40 per sheet)',
    widthMm: 50,
    heightMm: 25,
    page: 'a4',
    showText: true,
  },
  {
    id: 'roll-40x30',
    label: 'Label roll — 40 × 30 mm',
    widthMm: 40,
    heightMm: 30,
    page: 'roll',
    showText: true,
  },
  {
    id: 'roll-50x25',
    label: 'Label roll — 50 × 25 mm',
    widthMm: 50,
    heightMm: 25,
    page: 'roll',
    showText: true,
  },
]

export function labelSize(id: string): LabelSize {
  return LABEL_SIZES.find((size) => size.id === id) ?? (LABEL_SIZES[0] as LabelSize)
}

export interface SheetOptions {
  /** Printed small at the top of each label; empty omits the line. */
  shopName: string
  showPrice: boolean
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** One label. The barcode gets whatever height the text lines leave over. */
function labelHtml(item: LabelItem, size: LabelSize, options: SheetOptions): string {
  const shopLine =
    options.shopName && size.heightMm >= 25
      ? `<div class="shop">${escapeHtml(options.shopName)}</div>`
      : ''
  const priceLine =
    options.showPrice && item.price ? `<div class="price">${escapeHtml(item.price)}</div>` : ''

  return (
    `<div class="label">${shopLine}` +
    `<div class="name">${escapeHtml(item.name)}</div>` +
    `<div class="bars">${code128Svg(item.sku, { showText: size.showText, height: 40 })}</div>` +
    priceLine +
    `</div>`
  )
}

/**
 * The whole document. Every item appears `copies` times, in order, so the
 * sheet peels top-to-bottom the way a hand moves along a shelf.
 */
export function buildLabelSheet(
  items: readonly LabelItem[],
  size: LabelSize,
  options: SheetOptions
): string {
  const labels: string[] = []
  for (const item of items) {
    if (!code128Encodable(item.sku)) continue
    for (let copy = 0; copy < Math.max(1, Math.floor(item.copies)); copy += 1) {
      labels.push(labelHtml(item, size, options))
    }
  }

  const page =
    size.page === 'a4'
      ? `@page { size: A4; margin: 8mm; }`
      : `@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`

  // On a roll every label is its own page; on a sheet they flow and wrap.
  const flow =
    size.page === 'a4'
      ? `.sheet { display: flex; flex-wrap: wrap; align-content: flex-start; }`
      : `.label { page-break-after: always; }`

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #fff; font-family: system-ui, sans-serif; }
  ${flow}
  .label {
    width: ${size.widthMm}mm;
    height: ${size.heightMm}mm;
    padding: 1mm 1.5mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    text-align: center;
    page-break-inside: avoid;
  }
  .shop { font-size: 5.5pt; color: #000; white-space: nowrap; overflow: hidden; max-width: 100%; }
  .name {
    font-size: 6.5pt; font-weight: 600; color: #000; line-height: 1.15;
    max-height: 2.3em; overflow: hidden; max-width: 100%;
  }
  .price { font-size: 8pt; font-weight: 700; color: #000; }
  .bars { flex: 1; min-height: 0; width: 100%; display: flex; align-items: center; justify-content: center; }
  .bars svg { width: 100%; height: 100%; }
  ${page}
</style>
</head>
<body><div class="sheet">${labels.join('')}</div></body>
</html>`
}

/** How many labels the current selection will print — for the button text. */
export function countLabels(items: readonly LabelItem[]): number {
  return items.reduce(
    (total, item) => total + (code128Encodable(item.sku) ? Math.max(1, Math.floor(item.copies)) : 0),
    0
  )
}
