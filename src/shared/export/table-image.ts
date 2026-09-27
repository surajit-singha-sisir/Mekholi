/**
 * A table as a picture (§23's fourth export shape).
 *
 * Shops here share ledgers over WhatsApp, and WhatsApp flattens documents
 * but shows pictures inline — so "export image" is not a gimmick, it is
 * the format the conversation actually happens in. We draw onto a canvas
 * rather than shipping a screenshot library: `fillText` hands the string
 * to the platform's own text shaper, which is the only thing that renders
 * Bangla correctly without embedding fonts ourselves.
 *
 * The renderer is generic — columns, string rows, a title and a footer —
 * so any screen can hand its table over. Where there is no canvas (jsdom,
 * an ancient WebView) it returns null and the caller says so, instead of
 * downloading a zero-byte file.
 */

export interface TableImageColumn {
  label: string
  align?: 'left' | 'right'
}

export interface TableImageSpec {
  title: string
  subtitle?: string
  columns: readonly TableImageColumn[]
  /** Already-formatted display strings, one array per row. */
  rows: readonly string[][]
  footer?: string
}

const FONT = '"Noto Sans Bengali", system-ui, sans-serif'
const PAD = 20
const CELL_X = 14
const ROW_H = 34
const HEAD_H = 38
const MAX_COL = 340
const SCALE = 2

export function renderTableImage(spec: TableImageSpec): Promise<Blob | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof canvas.toBlob !== 'function') return Promise.resolve(null)

  // First pass: measure. Column width is its widest cell, capped so one
  // long note cannot stretch the picture past what a phone screen forgives.
  ctx.font = `13px ${FONT}`
  const widths = spec.columns.map((column, index) => {
    let width = measure(ctx, column.label, `600 13px ${FONT}`)
    for (const row of spec.rows) {
      width = Math.max(width, measure(ctx, row[index] ?? '', `13px ${FONT}`))
    }
    return Math.min(width + CELL_X * 2, MAX_COL)
  })

  const tableW = widths.reduce((sum, w) => sum + w, 0)
  const width = Math.max(tableW + PAD * 2, 480)
  const headerBlock = PAD + 26 + (spec.subtitle ? 22 : 6)
  const footerBlock = spec.footer ? 30 : PAD
  const height = headerBlock + HEAD_H + spec.rows.length * ROW_H + footerBlock

  canvas.width = width * SCALE
  canvas.height = height * SCALE
  ctx.scale(SCALE, SCALE)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'middle'

  ctx.fillStyle = '#111827'
  ctx.font = `600 17px ${FONT}`
  ctx.textAlign = 'left'
  ctx.fillText(spec.title, PAD, PAD + 9)
  if (spec.subtitle) {
    ctx.fillStyle = '#6b7280'
    ctx.font = `12px ${FONT}`
    ctx.fillText(spec.subtitle, PAD, PAD + 30)
  }

  // Header band.
  let y = headerBlock
  ctx.fillStyle = '#f3f4f6'
  ctx.fillRect(PAD, y, tableW, HEAD_H)
  ctx.font = `600 13px ${FONT}`
  ctx.fillStyle = '#374151'
  drawRow(ctx, spec.columns.map((column) => column.label), spec.columns, widths, y + HEAD_H / 2)

  // Body, zebra-striped so a finger can follow a row across ten columns.
  y += HEAD_H
  spec.rows.forEach((row, index) => {
    if (index % 2 === 1) {
      ctx.fillStyle = '#f9fafb'
      ctx.fillRect(PAD, y, tableW, ROW_H)
    }
    ctx.strokeStyle = '#e5e7eb'
    ctx.beginPath()
    ctx.moveTo(PAD, y)
    ctx.lineTo(PAD + tableW, y)
    ctx.stroke()
    ctx.font = `13px ${FONT}`
    ctx.fillStyle = '#111827'
    drawRow(ctx, row, spec.columns, widths, y + ROW_H / 2)
    y += ROW_H
  })
  ctx.strokeStyle = '#d1d5db'
  ctx.strokeRect(PAD, headerBlock, tableW, HEAD_H + spec.rows.length * ROW_H)

  if (spec.footer) {
    ctx.fillStyle = '#9ca3af'
    ctx.font = `11px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(spec.footer, PAD, y + 16)
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png')
  })
}

function measure(ctx: CanvasRenderingContext2D, text: string, font: string): number {
  ctx.font = font
  // jsdom's stub context returns undefined widths; treat them as zero.
  return ctx.measureText(text).width || 0
}

function drawRow(
  ctx: CanvasRenderingContext2D,
  cells: readonly string[],
  columns: readonly TableImageColumn[],
  widths: readonly number[],
  midY: number
): void {
  let x = PAD
  columns.forEach((column, index) => {
    const cellWidth = widths[index] ?? 0
    const text = clip(ctx, cells[index] ?? '', cellWidth - CELL_X * 2)
    if (column.align === 'right') {
      ctx.textAlign = 'right'
      ctx.fillText(text, x + cellWidth - CELL_X, midY)
    } else {
      ctx.textAlign = 'left'
      ctx.fillText(text, x + CELL_X, midY)
    }
    x += cellWidth
  })
}

/** Ellipsise what the capped column cannot hold; never let cells collide. */
function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if ((ctx.measureText(text).width || 0) <= maxWidth) return text
  let clipped = text
  while (clipped.length > 1 && (ctx.measureText(`${clipped}…`).width || 0) > maxWidth) {
    clipped = clipped.slice(0, -1)
  }
  return `${clipped}…`
}
