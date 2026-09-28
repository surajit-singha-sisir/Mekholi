/**
 * Data table (spec §23, §38).
 *
 * One table component serves every report, because "table" is where reports
 * go to become inconsistent: one screen right-aligns money, another does not;
 * one shows a totals row, another forgets; print output loses half the
 * columns. Here the columns come from the server's report spec — the same
 * array the CSV writer uses for its header — so the screen, the printout and
 * the file have the same columns in the same order by construction.
 *
 * Rows scroll horizontally on a phone rather than reflowing: a report is
 * tabular data, and a two-column card layout of a twelve-column table is
 * harder to read, not easier.
 */

import { h, icon, type Child } from './h'
import { badge, type BadgeTone } from './card'
import { formatMoney, minor, type Minor } from '../../shared/domain/money'
import type { ReportCell, ReportColumn, ReportColumnType } from '../../shared/repositories/contracts'

export interface TableOptions {
  columns: readonly ReportColumn[]
  rows: readonly Record<string, ReportCell>[]
  /** Column key → total, in minor units for money columns. */
  totals?: Record<string, number> | undefined
  sort?: string | undefined
  dir?: 'asc' | 'desc' | undefined
  currency?: string
  onSort?: ((key: string) => void) | undefined
  onRowClick?: ((row: Record<string, ReportCell>) => void) | undefined
  /** Rows past this render collapsed behind a "show all" button. */
  pageSize?: number
  emptyTitle?: string
  emptyDescription?: string
  /** Hide the header row where a card already names the columns. */
  dense?: boolean
}

const STATUS_TONES: Record<string, BadgeTone> = {
  COMPLETED: 'success',
  PAID: 'success',
  ok: 'success',
  settled: 'success',
  due: 'warning',
  RECEIVED: 'success',
  PARTIALLY_PAID: 'warning',
  PARTIALLY_REFUNDED: 'warning',
  PARTIALLY_RECEIVED: 'warning',
  low: 'warning',
  HELD: 'info',
  DRAFT: 'neutral',
  ORDERED: 'info',
  out: 'danger',
  CANCELLED: 'danger',
  REFUNDED: 'danger',
  untracked: 'neutral',
  // Due-book aging buckets: a week is trade, a month is patience.
  fresh: 'success',
  aging: 'warning',
  stale: 'danger',
}

/** "2026-09-25T10:14:00+06:00" → "25 Sep 2026, 10:14" without a date library. */
export function formatWhen(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatDay(value: string): string {
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

/**
 * A cell as text — the same string the CSV writer emits.
 *
 * Shared deliberately: when the screen and the export both go through this,
 * "the number in the file does not match the number on the screen" stops being
 * a class of bug that can exist.
 */
export function cellText(
  value: ReportCell,
  column: { type: ReportColumnType },
  currency = 'BDT'
): string {
  if (value === null || value === undefined || value === '') return '—'
  switch (column.type) {
    case 'money':
      // Report money is already in minor units — brand it, do not scale it.
      return formatMoney(minor(Math.trunc(Number(value))) as Minor, { currency })
    case 'qty': {
      const numeric = Number(value)
      return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(3).replace(/\.?0+$/, '')
    }
    case 'int':
      return new Intl.NumberFormat('en-IN').format(Number(value))
    case 'percent':
      return `${Number(value).toFixed(1)}%`
    case 'date':
      return formatWhen(String(value))
    default:
      return String(value)
  }
}

function renderCell(value: ReportCell, column: ReportColumn, currency: string): Child {
  if (column.type === 'status' && typeof value === 'string') {
    const tone = STATUS_TONES[value] ?? 'neutral'
    return badge(value.replace(/_/g, ' ').toLowerCase(), { tone })
  }
  const text = cellText(value, column, currency)
  return h('span', { class: value === null ? 'text-content-subtle' : '', text })
}

export function dataTable(options: TableOptions): HTMLElement {
  const currency = options.currency ?? 'BDT'
  const body = h('tbody', { class: 'divide-y divide-border' })
  let shown = options.pageSize ?? options.rows.length

  const headCells = options.columns.map((column) => {
    const sortable = Boolean(options.onSort)
    const isSorted = options.sort === column.key
    const alignRight = column.align === 'right'
    const th = h(
      'th',
      {
        class:
          'whitespace-nowrap px-3 py-2 text-xs font-medium text-content-muted ' +
          (alignRight ? 'text-right ' : 'text-left ') +
          (sortable ? 'cursor-pointer select-none hover:text-content ' : ''),
        scope: 'col',
      },
      h(
        'span',
        { class: `inline-flex items-center gap-1 ${alignRight ? 'justify-end' : ''}` },
        h('span', { text: column.label }),
        isSorted
          ? icon(options.dir === 'asc' ? 'arrow_upward' : 'arrow_downward', 'text-sm text-primary')
          : sortable
            ? icon('unfold_more', 'text-sm opacity-40')
            : null
      )
    )
    if (sortable && options.onSort) {
      const onSort = options.onSort
      th.addEventListener('click', () => onSort(column.key))
      th.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') onSort(column.key)
      })
      th.tabIndex = 0
    }
    return th
  })

  function renderRows(): void {
    body.replaceChildren()
    for (const row of options.rows.slice(0, shown)) {
      const tr = h('tr', { class: 'hover:bg-surface-muted/60' })
      for (const column of options.columns) {
        tr.appendChild(
          h(
            'td',
            {
              class:
                'whitespace-nowrap px-3 py-2 text-sm text-content ' +
                (column.align === 'right' ? 'text-right tabular-nums ' : '') +
                (column.type === 'money' ? 'tabular-nums ' : ''),
              'data-column': column.key,
            },
            renderCell(row[column.key] ?? null, column, currency)
          )
        )
      }
      if (options.onRowClick) {
        const handler = options.onRowClick
        tr.className += ' cursor-pointer'
        tr.addEventListener('click', () => handler(row))
      }
      body.appendChild(tr)
    }
  }

  renderRows()

  const table = h(
    'table',
    {
      // `w-max min-w-full`, not `w-full`.
      //
      // `w-full` pins the table to the width of its box, and auto layout then
      // shares the leftover space out between the columns in proportion to
      // their content — so a two-word status column is handed the same kind of
      // slab as the product name, and every table on the screen divides its
      // width differently from the last one. `w-max` sizes the table to what
      // is actually in it, which is what "auto" means for a column; `min-w-full`
      // keeps it filling the box when the content is narrower than the screen,
      // so a three-column report does not sit in a puddle on the left.
      class: 'w-max min-w-full table-auto border-collapse',
    },
    options.dense
      ? null
      : h(
          'thead',
          // Not sticky: a page scrolls as one document under the app's own
          // header, and a second frozen strip inside it was the thing that made
          // long lists feel like two pages fighting each other.
          { class: 'border-b border-border bg-surface-muted/80' },
          h('tr', null, ...headCells)
        ),
    body
  )

  const footer =
    options.totals && Object.keys(options.totals).length > 0
      ? h(
          'tfoot',
          { class: 'border-t border-border bg-surface-muted/60' },
          h(
            'tr',
            null,
            ...options.columns.map((column) => {
              const total = options.totals?.[column.key]
              return h(
                'td',
                {
                  class:
                    'whitespace-nowrap px-3 py-2 text-sm font-semibold text-content ' +
                    (column.align === 'right' ? 'text-right tabular-nums' : ''),
                },
                total === undefined
                  ? h('span', { class: 'text-content-subtle', text: column.align === 'right' ? '' : '' })
                  : cellText(total, { type: column.type }, currency)
              )
            })
          )
        )
      : null

  const more =
    options.rows.length > shown
      ? h(
          'div',
          { class: 'border-t border-border p-2 text-center' },
          h(
            'button',
            {
              type: 'button',
              class: 'text-xs font-medium text-primary hover:underline',
              onclick: (event: Event) => {
                shown = options.rows.length
                renderRows()
                // The button removes itself: the rows it revealed are the
                // content, and leaving a "show all" button under all of them
                // invites a second click that does nothing.
                ;(event.currentTarget as HTMLElement | null)?.remove()
              },
            },
            `Show all ${options.rows.length} rows`
          )
        )
      : null

  // `min-w-0` alongside `overflow-x-auto`: a flex or grid child defaults to
  // `min-width: auto`, which means it refuses to be narrower than its content.
  // Without it the *page* grows to the width of the widest table and the whole
  // app scrolls sideways — the scrollbar appears, just on the wrong element.
  const scroller = h('div', { class: 'w-full min-w-0 max-w-full overflow-x-auto' }, table)

  if (options.rows.length === 0) {
    return h(
      'div',
      { class: 'rounded-lg border border-border bg-surface' },
      h(
        'div',
        { class: 'flex flex-col items-center gap-1 py-10 text-center' },
        icon('table_rows', 'text-content-subtle text-3xl'),
        h('p', { class: 'text-sm font-medium text-content', text: options.emptyTitle ?? 'Nothing to show' }),
        h('p', {
          class: 'max-w-sm text-xs text-content-muted',
          text: options.emptyDescription ?? 'No rows match the filters for this period.',
        })
      )
    )
  }

  // The totals row goes *inside* the table, which is both where the HTML spec
  // puts a `tfoot` and the only way it can stay in step with the columns once
  // the table scrolls sideways. It used to be a sibling of the scroller, so a
  // wide table slid under a stationary total.
  if (footer) table.appendChild(footer)

  return h('div', { class: 'w-full min-w-0 rounded-lg border border-border bg-surface' }, scroller, more)
}
