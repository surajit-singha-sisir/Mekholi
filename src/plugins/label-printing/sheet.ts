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
    id: 'a4-64x34',
    label: 'A4 sheet — 64 × 34 mm (24 per sheet)',
    widthMm: 64,
    heightMm: 34,
    page: 'a4',
    showText: true,
  },
  {
    id: 'roll-32x19',
    label: 'Label roll — 32 × 19 mm',
    widthMm: 32,
    heightMm: 19,
    page: 'roll',
    showText: false,
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
  {
    id: 'roll-58x40',
    label: 'Label roll — 58 × 40 mm',
    widthMm: 58,
    heightMm: 40,
    page: 'roll',
    showText: true,
  },
  {
    id: 'roll-100x50',
    label: 'Label roll — 100 × 50 mm (carton)',
    widthMm: 100,
    heightMm: 50,
    page: 'roll',
    showText: true,
  },
]

export function labelSize(id: string): LabelSize {
  return LABEL_SIZES.find((size) => size.id === id) ?? (LABEL_SIZES[0] as LabelSize)
}

/**
 * The size on the packet the shop actually bought, when it matches none of
 * ours. Clamped to what a barcode can survive: below 20mm wide the bars stop
 * scanning, beyond 150mm it is a poster, not a label.
 */
export function customLabelSize(widthMm: number, heightMm: number, page: 'a4' | 'roll'): LabelSize {
  const w = Math.min(150, Math.max(20, widthMm || 0))
  const h = Math.min(150, Math.max(12, heightMm || 0))
  return {
    id: 'custom',
    label: `Custom — ${w} × ${h} mm`,
    widthMm: w,
    heightMm: h,
    page,
    showText: h >= 25,
  }
}

export interface SheetOptions {
  /** Printed small at the top of each label; empty omits the line. */
  shopName: string
  showPrice: boolean
  /** Print the product name line. Default true — a label is for humans too. */
  showName?: boolean
  /** Human-readable SKU under the bars. Default: whatever the size allows. */
  skuText?: boolean
  /** Write "MRP" before the price, the way BD shelf tickets read. */
  mrp?: boolean
  /** One extra small line on every label — a phone number, an address. */
  noteLine?: string
  /** Pre-formatted date line ("Packed: 28 Sep 2026"); empty omits. */
  packedDate?: string
  /** 0.85 small · 1 normal · 1.2 large — every text line scales together. */
  fontScale?: number
  /** A4 only: leave this many sticker cells blank — a partly used sheet. */
  skipCells?: number
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
  const nameLine =
    options.showName === false ? '' : `<div class="name">${escapeHtml(item.name)}</div>`
  const priceLine =
    options.showPrice && item.price
      ? `<div class="price">${options.mrp ? 'MRP ' : ''}${escapeHtml(item.price)}</div>`
      : ''
  const noteLine = options.noteLine?.trim()
    ? `<div class="note">${escapeHtml(options.noteLine.trim())}</div>`
    : ''
  const dateLine = options.packedDate?.trim()
    ? `<div class="note">${escapeHtml(options.packedDate.trim())}</div>`
    : ''

  return (
    `<div class="label">${shopLine}` +
    nameLine +
    `<div class="bars">${code128Svg(item.sku, { showText: options.skuText ?? size.showText, height: 40 })}</div>` +
    priceLine +
    noteLine +
    dateLine +
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
  // A partly used sticker sheet: the first N cells are already gone, so the
  // run starts where the stickers actually are. Blank cells carry no ink.
  if (size.page === 'a4') {
    const skip = Math.max(0, Math.min(200, Math.floor(options.skipCells ?? 0)))
    for (let cell = 0; cell < skip; cell += 1) {
      labels.push('<div class="label blank"></div>')
    }
  }
  for (const item of items) {
    if (!code128Encodable(item.sku)) continue
    for (let copy = 0; copy < Math.max(1, Math.floor(item.copies)); copy += 1) {
      labels.push(labelHtml(item, size, options))
    }
  }

  // One knob scales every text line together — nobody sizes lines separately
  // on a 21mm sticker; they want "a bit bigger" or "a bit smaller".
  const scale = options.fontScale && options.fontScale > 0 ? options.fontScale : 1
  const pt = (base: number): string => `${Math.round(base * scale * 10) / 10}pt`

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
  .shop { font-size: ${pt(5.5)}; color: #000; white-space: nowrap; overflow: hidden; max-width: 100%; }
  .name {
    font-size: ${pt(6.5)}; font-weight: 600; color: #000; line-height: 1.15;
    max-height: 2.3em; overflow: hidden; max-width: 100%;
  }
  .price { font-size: ${pt(8)}; font-weight: 700; color: #000; }
  .note { font-size: ${pt(5)}; color: #000; white-space: nowrap; overflow: hidden; max-width: 100%; }
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
