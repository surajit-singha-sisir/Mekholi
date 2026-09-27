/**
 * The receipt itself: the data, and the paper.
 *
 * `buildReceipt` turns a stored sale into a plain structure — no DOM, no
 * formatting decisions — and `renderReceipt` turns that into the slip. The
 * split matters because the data model is what an Android client, an email
 * sender and a fiscal integration all need, while the paper is one of several
 * possible renderings of it.
 *
 * ── Why this is in `shared/` ─────────────────────────────────────────────
 * It used to live in `features/pos`, which was true when only the till
 * printed. It is now also the Sales screen reprinting an old invoice and the
 * Printer Setup plugin previewing a design — and a plugin may not import a
 * feature (spec §51). Nothing here knows about a screen, a toast or a
 * printer; those stay in the callers.
 *
 * 80mm thermal stock is 72mm printable inside the margins. At 96dpi that is
 * about 272px, so the layout is fixed to that width rather than made
 * responsive: a receipt that reflows is a receipt that does not fit the paper.
 */

import { h } from '../../components/ui/h'
import { formatMoney, formatQty, milli, minor, type Minor } from '../domain/money'
import type { SaleRow } from '../types/records'
import { DEFAULT_INVOICE_DESIGN, resolveDesign, type InvoiceDesign } from './design'

// ── Data model ────────────────────────────────────────────────────────────

export interface ReceiptLine {
  name: string
  variant: string | null
  /**
   * Plugin-printed values for this line (`printable` product fields, spec §32):
   * a batch number, an expiry date, a warranty code. Empty when no plugin asked
   * for one, which is every shop with no plugins installed.
   */
  notes: string[]
  /** Already carries the unit symbol, e.g. `1.5 kg` or `3 ea`. */
  quantity: string
  unitPrice: string
  lineTotal: string
}

export interface ReceiptData {
  shopName: string
  invoiceNo: string
  status: string
  soldAt: string
  cashier: string
  customer: string
  currency: string
  lines: ReceiptLine[]
  subtotal: string
  discount: string
  tax: string
  total: string
  paid: string
  change: string
  note: string | null
}

/**
 * Turn a stored sale into a receipt.
 *
 * Reads only the columns the sale actually has. Nothing here recomputes a
 * total: the numbers on the paper are the numbers Postgres stored, so a
 * reprint months later matches the original.
 */
export function buildReceipt(
  sale: SaleRow,
  shopName: string,
  /** Printed per line, keyed by variant id — what the till knew at the time. */
  notes: ReadonlyMap<string, readonly string[]> = new Map()
): ReceiptData {
  const money = (value: string | null | undefined): string =>
    formatMoney(minor(Math.round(Number(value ?? 0) * 100) as Minor), {
      currency: sale.currency,
    })

  return {
    shopName,
    invoiceNo: sale.invoice_no,
    status: humanStatus(sale.status),
    soldAt: new Date(sale.completed_at ?? sale.created_at).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    cashier: sale.created_by ?? '—',
    customer: sale.customer?.name ?? 'Walk-in',
    currency: sale.currency,
    lines: (sale.items ?? []).map((item) => ({
      name: item.product_name,
      variant: item.variant_name,
      quantity: formatQty(milli(Math.round(Number(item.quantity) * 1000)), {
        decimal: !Number.isInteger(Number(item.quantity)),
        unitLabel: item.unit_label ?? undefined,
      }),
      unitPrice: money(item.unit_price),
      lineTotal: money(item.line_total),
      notes: [...(notes.get(item.variant_id) ?? [])],
    })),
    subtotal: money(sale.subtotal),
    discount: money(sale.discount_total),
    tax: money(sale.tax_total),
    total: money(sale.total),
    paid: money(sale.paid_total),
    change: money(sale.change_due),
    note: sale.note,
  }
}

function humanStatus(status: string): string {
  switch (status) {
    case 'COMPLETED':
      return 'Paid'
    case 'PARTIALLY_PAID':
      return 'Part paid'
    case 'REFUNDED':
      return 'Refunded'
    case 'PARTIALLY_REFUNDED':
      return 'Part refunded'
    default:
      return status
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

/** 72mm at 96dpi, which is the printable width inside 80mm stock. */
const RECEIPT_WIDTH_PX = 272

export const RECEIPT_WIDTH = RECEIPT_WIDTH_PX

/**
 * The paper's stylesheet.
 *
 * Font size and line height come from the design, so the same markup prints
 * as a tight 58mm slip or a roomy document without a second template.
 */
export function receiptCss(design: InvoiceDesign = DEFAULT_INVOICE_DESIGN): string {
  const resolved = resolveDesign(design)
  return `
  .mekholi-receipt {
    width: ${RECEIPT_WIDTH_PX}px;
    margin: 0 auto;
    padding: 8px 4px 16px;
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: ${(11 * resolved.fontScale).toFixed(2)}px;
    line-height: ${resolved.lineHeight};
    color: #000;
    background: #fff;
  }
  .mekholi-receipt h1 { font-size: 14px; text-align: center; margin: 0 0 2px; letter-spacing: .04em; }
  .mekholi-receipt .center { text-align: center; }
  .mekholi-receipt .rule { border-top: 1px dashed #000; margin: 6px 0; }
  .mekholi-receipt table { width: 100%; border-collapse: collapse; }
  .mekholi-receipt td { vertical-align: top; padding: 1px 0; }
  .mekholi-receipt td.num { text-align: right; white-space: nowrap; }
  .mekholi-receipt .muted { opacity: .75; }
  .mekholi-receipt .big { font-size: 14px; font-weight: 700; }
  @media print {
    body { margin: 0; background: #fff; }
    body > *:not(#mekholi-print-root) { display: none !important; }
    #mekholi-print-root { position: static; inset: auto; background: #fff; padding: 0; overflow: visible; }
    .mekholi-receipt-actions { display: none !important; }
    @page { size: 80mm auto; margin: 2mm; }
  }
`
}


/**
 * The slip. Pure: give it data and a design, get a node.
 *
 * The design decides *what* is on the paper; nothing here decides anything
 * the shopkeeper could have. Defaults reproduce the layout that shipped
 * before designs existed, so a device that has never opened the setup screen
 * prints exactly what it always printed.
 */
export function renderReceipt(data: ReceiptData, design: InvoiceDesign = DEFAULT_INVOICE_DESIGN): HTMLElement {
  const look = resolveDesign(design)

  const row = (label: string, value: string, strong = false): HTMLElement =>
    h('tr', {},
      h('td', { class: strong ? 'big' : '', text: label }),
      h('td', { class: `num ${strong ? 'big' : ''}`.trim(), text: value })
    )

  /** One item, at the density the template asks for. */
  const itemRows = (line: ReceiptData['lines'][number]): HTMLElement[] => {
    if (look.oneLinePerItem) {
      // Compact: the name and the money, and the quantity only when it is
      // not one — "1 ×" on every line is the noise this template removes.
      const prefix = line.quantity.startsWith('1 ') || line.quantity === '1' ? '' : `${line.quantity} `
      return [
        h('tr', {},
          h('td', { text: `${prefix}${line.name}` }),
          h('td', { class: 'num', text: line.lineTotal })
        ),
      ]
    }

    return [
      h('tr', {}, h('td', { colspan: '2', text: line.name })),
      ...(line.variant ? [h('tr', {}, h('td', { colspan: '2', class: 'muted', text: `  ${line.variant}` }))] : []),
      h('tr', {},
        h('td', {
          class: 'muted',
          text: look.showUnitPrice ? `  ${line.quantity} × ${line.unitPrice}` : `  ${line.quantity}`,
        }),
        h('td', { class: 'num', text: line.lineTotal })
      ),
      // What a plugin asked to print for this line, under it, small.
      ...(look.showItemNotes
        ? line.notes.map((note) => h('tr', {}, h('td', { colspan: '2', class: 'muted', text: `  ${note}` })))
        : []),
    ]
  }

  return h(
    'div',
    { class: 'mekholi-receipt' },
    // The form names itself. On a Mushak-6.3 the heading is what turns a
    // till slip into the VAT invoice the buyer is entitled to keep — the
    // NBR's form number, in both scripts, above the seller's identity.
    ...(look.mushak
      ? [h('p', { class: 'center', text: 'মূসক-৬.৩ · VAT Invoice (Mushak-6.3)' })]
      : []),
    h('h1', { text: design.shopName.trim() || data.shopName }),
    ...look.headerLines.map((line) => h('p', { class: 'center muted', text: line })),
    ...(look.binNumber ? [h('p', { class: 'center muted', text: `BIN: ${look.binNumber}` })] : []),
    h('p', { class: 'center muted', text: data.invoiceNo }),
    h('p', { class: 'center muted', text: `${data.soldAt} · ${data.status}` }),
    ...(look.showCustomer ? [h('p', { class: 'center muted', text: `Served: ${data.customer}` })] : []),
    ...(look.showCashier ? [h('p', { class: 'center muted', text: `Cashier: ${data.cashier}` })] : []),

    h('div', { class: 'rule' }),

    h('table', {}, h('tbody', {}, ...data.lines.flatMap(itemRows))),

    h('div', { class: 'rule' }),

    h('table', {},
      h('tbody', {},
        row('Subtotal', data.subtotal),
        ...(Number(data.discount.replace(/[^0-9.-]/g, '')) > 0 ? [row('Discount', `-${data.discount}`)] : []),
        // A Mushak-6.3 states the VAT even when it is zero — an absent line
        // reads as an omission on a tax document, where ৳0.00 is an answer.
        ...(look.mushak
          ? [row('VAT', data.tax)]
          : Number(data.tax.replace(/[^0-9.-]/g, '')) > 0
            ? [row('Tax', data.tax)]
            : []),
        row(look.mushak ? 'TOTAL (incl. VAT)' : 'TOTAL', data.total, true),
        row('Paid', data.paid),
        row('Change', data.change)
      )
    ),

    ...(data.note ? [h('div', { class: 'rule' }), h('p', { class: 'muted', text: data.note })] : []),

    ...(look.footerText
      ? [h('div', { class: 'rule' }), h('p', { class: 'center muted', text: look.footerText })]
      : [])
  )
}
