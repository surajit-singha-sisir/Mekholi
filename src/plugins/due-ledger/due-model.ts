/**
 * The due book's model — everything that is arithmetic, away from the DOM.
 *
 * The server sends seven facts per debtor (059). This module derives the
 * rest of the ledger a shopkeeper actually reads: how long the oldest debt
 * has waited, whether that makes it fresh, aging or stale, how much of the
 * credit limit is burned, and what share of the whole book one name holds.
 * It also builds every export from the same column spec the table renders
 * — screen, file, paper and picture agree by construction (§23).
 */

import { formatMoney, minor } from '../../shared/domain/money'
import { toCsv } from '../../shared/export/csv'
import { escapeHtml, printStyles } from '../../shared/export/download'
import type { ReportCell, ReportColumn } from '../../shared/repositories/contracts'

export interface Debtor {
  id: string
  name: string
  phone: string | null
  balance_minor: number
  credit_limit_minor: number
  open_sales: number
  oldest_due_at: string | null
}

export interface DueBook {
  total_due_minor: number
  debtor_count: number
  debtors: Debtor[]
}

export type Aging = 'fresh' | 'aging' | 'stale'

/** Under a week is trade, under a month is patience, past it is a problem. */
export function agingOf(days: number | null): Aging {
  if (days === null || days < 7) return 'fresh'
  if (days <= 30) return 'aging'
  return 'stale'
}

export function daysWaiting(oldest: string | null, now = Date.now()): number | null {
  if (!oldest) return null
  const at = Date.parse(oldest)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.floor((now - at) / 86_400_000))
}

/** One debtor, with every derived figure the table shows. */
export interface DebtorRow extends Record<string, ReportCell> {
  id: string
  name: string
  phone: string
  balance: number
  share: number
  invoices: number
  oldest: string | null
  days: number | null
  limit: number | null
  used: number | null
  aging: Aging
}

export const DUE_COLUMNS: readonly ReportColumn[] = [
  { key: 'name', label: 'Customer', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'balance', label: 'Due', type: 'money', align: 'right' },
  { key: 'share', label: 'Of book', type: 'percent', align: 'right' },
  { key: 'invoices', label: 'Invoices', type: 'int', align: 'right' },
  { key: 'oldest', label: 'Oldest sale', type: 'date' },
  { key: 'days', label: 'Days', type: 'int', align: 'right' },
  { key: 'limit', label: 'Credit limit', type: 'money', align: 'right' },
  { key: 'used', label: 'Limit used', type: 'percent', align: 'right' },
  { key: 'aging', label: 'Age', type: 'status' },
]

export function toRows(book: DueBook, now = Date.now()): DebtorRow[] {
  const total = book.total_due_minor
  return book.debtors.map((debtor) => {
    const days = daysWaiting(debtor.oldest_due_at, now)
    const limit = debtor.credit_limit_minor > 0 ? debtor.credit_limit_minor : null
    return {
      id: debtor.id,
      name: debtor.name,
      phone: debtor.phone ?? '',
      balance: debtor.balance_minor,
      share: total > 0 ? round1((debtor.balance_minor / total) * 100) : 0,
      invoices: debtor.open_sales,
      oldest: debtor.oldest_due_at,
      days,
      limit,
      used: limit ? round1((debtor.balance_minor / limit) * 100) : null,
      aging: agingOf(days),
    }
  })
}

// ── Sorting ───────────────────────────────────────────────────────────────

const AGING_RANK: Record<Aging, number> = { stale: 0, aging: 1, fresh: 2 }

/**
 * Client-side, typed sort. Money, numbers and days compare numerically,
 * dates by their instant, the age column by urgency (stale first when
 * descending is asked for the first time feels wrong — stale first IS the
 * urgent order, so 'desc' on age means most urgent first). Nulls sink to
 * the bottom whichever way the column points: an empty cell is never the
 * winner of a sort.
 */
export function sortRows(rows: readonly DebtorRow[], key: string, dir: 'asc' | 'desc'): DebtorRow[] {
  const column = DUE_COLUMNS.find((c) => c.key === key)
  if (!column) return [...rows]
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = a[key] as ReportCell
    const bv = b[key] as ReportCell
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    if (key === 'aging') return sign * (AGING_RANK[av as Aging] - AGING_RANK[bv as Aging])
    if (column.type === 'date') return sign * (Date.parse(String(av)) - Date.parse(String(bv)))
    if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv)
    return sign * String(av).localeCompare(String(bv))
  })
}

// ── The headline numbers ──────────────────────────────────────────────────

export interface BucketStat {
  count: number
  totalMinor: number
}

export interface DueStats {
  totalMinor: number
  debtors: number
  averageMinor: number
  oldestDays: number | null
  buckets: Record<Aging, BucketStat>
}

export function bookStats(rows: readonly DebtorRow[]): DueStats {
  const buckets: Record<Aging, BucketStat> = {
    fresh: { count: 0, totalMinor: 0 },
    aging: { count: 0, totalMinor: 0 },
    stale: { count: 0, totalMinor: 0 },
  }
  let total = 0
  let oldest: number | null = null
  for (const row of rows) {
    total += row.balance
    buckets[row.aging].count += 1
    buckets[row.aging].totalMinor += row.balance
    if (row.days !== null && (oldest === null || row.days > oldest)) oldest = row.days
  }
  return {
    totalMinor: total,
    debtors: rows.length,
    averageMinor: rows.length > 0 ? Math.round(total / rows.length) : 0,
    oldestDays: oldest,
    buckets,
  }
}

// ── Exports: same columns, four shapes ────────────────────────────────────

/** Machine numbers: money in major units as plain decimals, dates as ISO. */
export function dueCsv(rows: readonly DebtorRow[]): string {
  const columns = DUE_COLUMNS.map(({ key, label }) => ({ key, label }))
  return toCsv(
    columns,
    rows.map((row) => ({
      name: row.name,
      phone: row.phone,
      balance: row.balance / 100,
      share: row.share,
      invoices: row.invoices,
      oldest: row.oldest ? row.oldest.slice(0, 10) : '',
      days: row.days,
      limit: row.limit === null ? null : row.limit / 100,
      used: row.used,
      aging: row.aging,
    })),
    { bom: true }
  )
}

/** Eye numbers: what one cell reads as on paper and in the picture. */
export function cellDisplay(row: DebtorRow, key: string, currency: string): string {
  const value = row[key] as ReportCell
  if (value === null || value === '') return '—'
  switch (DUE_COLUMNS.find((c) => c.key === key)?.type) {
    case 'money':
      return formatMoney(minor(Number(value)), { currency, digits: 'latin', convert: false })
    case 'percent':
      return `${Number(value).toFixed(1)}%`
    case 'date':
      return String(value).slice(0, 10)
    default:
      return String(value)
  }
}

/** The printable book — the browser's own "Save as PDF" finishes the job. */
export function duePrintHtml(rows: readonly DebtorRow[], currency: string, shopName: string): string {
  const stats = bookStats(rows)
  const money = (value: number): string =>
    formatMoney(minor(value), { currency, digits: 'latin', convert: false })
  const head = DUE_COLUMNS.map(
    (column) => `<th style="text-align:${column.align ?? 'left'}">${escapeHtml(column.label)}</th>`
  ).join('')
  const body = rows
    .map(
      (row) =>
        `<tr>${DUE_COLUMNS.map(
          (column) =>
            `<td style="text-align:${column.align ?? 'left'}">${escapeHtml(cellDisplay(row, column.key, currency))}</td>`
        ).join('')}</tr>`
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Due book</title><style>${printStyles()}</style></head>
<body>
<h1>${escapeHtml(shopName)} — Due book (বাকির খাতা)</h1>
<p>${escapeHtml(money(stats.totalMinor))} owed by ${stats.debtors} customer(s) · printed ${new Date().toLocaleString()}</p>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>
<tfoot><tr><td><strong>Total</strong></td><td></td><td style="text-align:right"><strong>${escapeHtml(money(stats.totalMinor))}</strong></td><td colspan="7"></td></tr></tfoot>
</table>
</body></html>`
}

/** Clipboard shape: tab-separated, pastes straight into a spreadsheet. */
export function dueClipboardText(rows: readonly DebtorRow[], currency: string): string {
  const lines = [DUE_COLUMNS.map((column) => column.label).join('\t')]
  for (const row of rows) {
    lines.push(DUE_COLUMNS.map((column) => cellDisplay(row, column.key, currency)).join('\t'))
  }
  return lines.join('\n')
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
