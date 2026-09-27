/**
 * What every tabular screen wants next: sorting and a way out (§23, §38).
 *
 * `dataTable` renders columns; this module finishes the job. One typed
 * client-side sorter, and one toolbar that leaves the table in the four
 * shapes a shop actually uses — CSV for the spreadsheet, PNG for WhatsApp,
 * the print dialog for paper or the browser's own "Save as PDF", and the
 * clipboard for everything else. All four are built from the same
 * `ReportColumn` array the table renders, so the screen, the file, the
 * picture and the paper agree by construction.
 *
 * Display strings go through `cellText` — the exact formatter the table
 * cells use. Machine values (CSV) stay raw: money becomes major-unit plain
 * decimals, dates become ISO days, because a spreadsheet wants numbers it
 * can add, not strings shaped for the eye.
 */

import { h, icon } from './h'
import { cellText } from './table'
import { toCsv, type CsvValue } from '../../shared/export/csv'
import { downloadText, downloadBlob, printDocument, printStyles, escapeHtml } from '../../shared/export/download'
import { renderTableImage } from '../../shared/export/table-image'
import type { ReportCell, ReportColumn } from '../../shared/repositories/contracts'

// ── Sorting ───────────────────────────────────────────────────────────────

/**
 * Sort rows by one column, by that column's own type: money, counts and
 * percentages numerically, dates by their instant, text by locale. Empty
 * cells sink to the bottom whichever way the column points — a blank is
 * never the winner of a sort.
 */
export function sortReportRows<T extends Record<string, ReportCell>>(
  columns: readonly ReportColumn[],
  rows: readonly T[],
  key: string,
  dir: 'asc' | 'desc'
): T[] {
  const column = columns.find((c) => c.key === key)
  if (!column) return [...rows]
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = a[key] as ReportCell
    const bv = b[key] as ReportCell
    const aEmpty = av === null || av === undefined || av === ''
    const bEmpty = bv === null || bv === undefined || bv === ''
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1
    if (column.type === 'date') return sign * (Date.parse(String(av)) - Date.parse(String(bv)))
    if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv)
    return sign * String(av).localeCompare(String(bv))
  })
}

// ── The four ways out ─────────────────────────────────────────────────────

export interface ExportToolbarOptions {
  /** Heading on the picture and the printout, e.g. 'Customers'. */
  title: string
  /** Filename base, no extension: 'customers' → customers-2026-09-28.csv */
  filename: string
  columns: readonly ReportColumn[]
  currency: string
  /** Called at click time — exports always carry what the eye currently sees. */
  rows: () => readonly Record<string, ReportCell>[]
  /** One line under the title, e.g. '43 customers · ৳12,400 due'. */
  subtitle?: () => string
  /** Small print on the picture, e.g. the shop name. */
  footerNote?: string
  /** Where 'CSV saved.' / 'The clipboard is not available.' should go. */
  onNotice: (message: string, bad: boolean) => void
}

/** Money leaves as major units a spreadsheet can add; dates as ISO days. */
function machineValue(value: ReportCell, column: ReportColumn): CsvValue {
  if (value === null || value === undefined || value === '') return null
  if (column.type === 'money') return Number(value) / 100
  if (column.type === 'date') return String(value).slice(0, 10)
  return typeof value === 'number' ? value : String(value)
}

function displayRows(options: ExportToolbarOptions): string[][] {
  return options
    .rows()
    .map((row) => options.columns.map((column) => cellText(row[column.key] ?? null, column, options.currency)))
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}

export function exportToolbar(options: ExportToolbarOptions): HTMLElement {
  const notice = options.onNotice

  function exportCsv(): void {
    const csv = toCsv(
      options.columns.map(({ key, label }) => ({ key, label })),
      options.rows().map((row) => {
        const out: Record<string, CsvValue> = {}
        for (const column of options.columns) out[column.key] = machineValue(row[column.key] ?? null, column)
        return out
      }),
      { bom: true }
    )
    const result = downloadText(`${options.filename}-${stamp()}.csv`, csv)
    notice(result.ok ? 'CSV saved.' : (result.reason ?? 'The file could not be saved.'), !result.ok)
  }

  async function exportImage(): Promise<void> {
    const blob = await renderTableImage({
      title: options.title,
      ...(options.subtitle ? { subtitle: options.subtitle() } : {}),
      columns: options.columns.map((column) => ({ label: column.label, align: column.align ?? 'left' })),
      rows: displayRows(options),
      ...(options.footerNote ? { footer: options.footerNote } : {}),
    })
    if (!blob) {
      notice('This device cannot draw the picture.', true)
      return
    }
    const result = downloadBlob(`${options.filename}-${stamp()}.png`, blob)
    notice(result.ok ? 'Image saved.' : (result.reason ?? 'The image could not be saved.'), !result.ok)
  }

  function exportPrint(): void {
    const head = options.columns
      .map((column) => `<th style="text-align:${column.align ?? 'left'}">${escapeHtml(column.label)}</th>`)
      .join('')
    const body = displayRows(options)
      .map(
        (cells) =>
          `<tr>${cells
            .map((cell, i) => `<td style="text-align:${options.columns[i]?.align ?? 'left'}">${escapeHtml(cell)}</td>`)
            .join('')}</tr>`
      )
      .join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title><style>${printStyles()}</style></head>
<body>
<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.subtitle ? options.subtitle() : '')} · printed ${new Date().toLocaleString()}</p>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`
    const result = printDocument(html, options.title)
    if (!result.ok) notice(result.reason ?? 'The print window was blocked.', true)
  }

  async function copyRows(): Promise<void> {
    const lines = [options.columns.map((column) => column.label).join('\t')]
    for (const cells of displayRows(options)) lines.push(cells.join('\t'))
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      notice('Copied — paste it into any spreadsheet or chat.', false)
    } catch {
      notice('The clipboard is not available on this device.', true)
    }
  }

  const tool = (label: string, iconName: string, onclick: () => void): HTMLElement =>
    h(
      'button',
      {
        type: 'button',
        class:
          'flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-content hover:bg-surface-muted',
        onclick,
        'aria-label': label,
      },
      icon(iconName, 'text-base'),
      label
    )

  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-1.5' },
    tool('CSV', 'download', exportCsv),
    tool('Image', 'image', () => void exportImage()),
    tool('PDF / Print', 'picture_as_pdf', exportPrint),
    tool('Copy', 'content_copy', () => void copyRows())
  )
}
