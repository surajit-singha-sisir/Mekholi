/**
 * The due book screen: everyone who owes, in the universal table.
 *
 * Deliberately a *book*, not a workflow — collection still lives on the
 * customer card where the identity and the history already are. But a book
 * is only useful if it answers standing questions at a glance, so this one
 * shows the whole ledger per debtor (due, share of the book, invoices,
 * oldest sale, days waiting, credit limit and how much of it is burned,
 * and an age bucket), sorts by any column, filters by age, and leaves the
 * shop in all four shapes a shop needs: CSV for the spreadsheet, PNG for
 * WhatsApp, the print dialog for paper or the browser's own PDF, and the
 * clipboard for everything else.
 */

import { h, icon, mount } from '../../components/ui/h'
import { badge, card, emptyState, stat } from '../../components/ui/card'
import { button, spinner } from '../../components/ui/button'
import { searchInput } from '../../components/ui/input'
import { dataTable } from '../../components/ui/table'
import { modal } from '../../components/feedback/modal'
import { formatMoney, minor } from '../../shared/domain/money'
import { downloadText, downloadBlob, printDocument } from '../../shared/export/download'
import { csvFilename } from '../../shared/export/csv'
import { renderTableImage } from '../../shared/export/table-image'
import type { PluginDb } from '../../shared/registry/plugin-types'
import {
  DUE_COLUMNS,
  bookStats,
  cellDisplay,
  dueClipboardText,
  dueCsv,
  duePrintHtml,
  sortRows,
  toRows,
  type Aging,
  type DebtorRow,
  type DueBook,
} from './due-model'

export interface DueScreenOptions {
  db: PluginDb
  currency: string
  /** Route jump without a full page reload; the plugin has no router. */
  go?: (to: string) => void
}

const AGE_FILTERS: readonly { key: Aging | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'fresh', label: 'Fresh (<7d)' },
  { key: 'aging', label: 'Aging (7–30d)' },
  { key: 'stale', label: 'Stale (30d+)' },
]

export function createDueScreen(options: DueScreenOptions): HTMLElement {
  const { db, currency } = options

  // Full width by request: a ten-column ledger earns the whole screen.
  const root = h('div', { class: 'flex w-full flex-col gap-4 p-4' })
  const statsSlot = h('div', {})
  const toolbarSlot = h('div', {})
  const tableSlot = h('div', {})
  const noticeSlot = h('div', { 'aria-live': 'polite' })

  let search = ''
  let ageFilter: Aging | 'all' = 'all'
  let sortKey = 'balance'
  let sortDir: 'asc' | 'desc' = 'desc'
  let allRows: DebtorRow[] = []
  let loaded = false

  function notice(text: string, bad = false): void {
    mount(
      noticeSlot,
      text
        ? h('p', {
            class: `rounded-lg border border-border bg-surface px-3 py-2 text-xs ${bad ? 'text-danger' : 'text-content-muted'}`,
            text,
          })
        : h('span', {})
    )
    if (text && !bad) setTimeout(() => mount(noticeSlot, h('span', {})), 4000)
  }

  function visibleRows(): DebtorRow[] {
    const filtered = ageFilter === 'all' ? allRows : allRows.filter((row) => row.aging === ageFilter)
    return sortRows(filtered, sortKey, sortDir)
  }

  // ── Exports: always what the eye currently sees (filter + sort applied) ──

  function exportCsv(): void {
    const result = downloadText(csvFilename('due-book', new Date().toISOString().slice(0, 10)), dueCsv(visibleRows()))
    notice(result.ok ? 'CSV saved.' : (result.reason ?? 'The file could not be saved.'), !result.ok)
  }

  async function exportImage(): Promise<void> {
    const rows = visibleRows()
    const stats = bookStats(rows)
    const blob = await renderTableImage({
      title: 'Due book (বাকির খাতা)',
      subtitle: `${formatMoney(minor(stats.totalMinor), { currency, digits: 'latin', convert: false })} owed by ${stats.debtors} customer(s) · ${new Date().toLocaleDateString()}`,
      columns: DUE_COLUMNS.map((column) => ({ label: column.label, align: column.align ?? 'left' })),
      rows: rows.map((row) => DUE_COLUMNS.map((column) => cellDisplay(row, column.key, currency))),
      footer: 'Mekholi POS',
    })
    if (!blob) {
      notice('This device cannot draw the picture.', true)
      return
    }
    const result = downloadBlob(`due-book-${new Date().toISOString().slice(0, 10)}.png`, blob)
    notice(result.ok ? 'Image saved.' : (result.reason ?? 'The image could not be saved.'), !result.ok)
  }

  function exportPdf(): void {
    const result = printDocument(duePrintHtml(visibleRows(), currency, 'Mekholi'), 'Due book')
    if (!result.ok) notice(result.reason ?? 'The print window was blocked.', true)
  }

  async function copyBook(): Promise<void> {
    try {
      await navigator.clipboard.writeText(dueClipboardText(visibleRows(), currency))
      notice('Copied — paste it into any spreadsheet or chat.')
    } catch {
      notice('The clipboard is not available on this device.', true)
    }
  }

  // ── The debtor's detail ────────────────────────────────────────────────
  //
  // A row in a ledger is a question — "what is behind this figure?" — and the
  // answer belongs where the eye already is, not on another screen. So a tap
  // opens the same kind of detail card the Sales screen uses for an invoice:
  // who owes, how much, since when, how many invoices behind it, and how close
  // they are to their credit limit. Collection still lives on the customer
  // card (that is where the identity and the payment history are), so the modal
  // links there rather than trying to take money from a read-only book.

  const AGING_META: Record<Aging, { tone: 'success' | 'warning' | 'danger'; label: string }> = {
    fresh: { tone: 'success', label: 'Fresh (<7d)' },
    aging: { tone: 'warning', label: 'Aging (7–30d)' },
    stale: { tone: 'danger', label: 'Stale (30d+)' },
  }

  function openDueDetail(row: DebtorRow): void {
    const money = (value: number): string => formatMoney(minor(value), { currency })
    const aging = AGING_META[row.aging]

    const field = (
      label: string,
      value: string,
      tone = 'text-content'
    ): HTMLElement =>
      h(
        'div',
        { class: 'flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0' },
        h('span', { class: 'text-sm text-content-muted', text: label }),
        h('span', { class: `text-sm font-medium tabular-nums ${tone}`, text: value })
      )

    const dialog = modal({
      title: 'Due details',
      subtitle: row.name,
      iconName: 'menu_book',
      size: 'md',
      footer: [
        button('Close', { variant: 'ghost', onClick: () => dialog.close() }),
        ...(options.go
          ? [
              button('Open customer card', {
                variant: 'primary',
                icon: 'person',
                onClick: () => {
                  dialog.close()
                  options.go?.('/customers')
                },
              }),
            ]
          : []),
      ],
    })

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        // Who, and how urgent — the two facts read first.
        h(
          'div',
          { class: 'flex flex-wrap items-start justify-between gap-3' },
          h(
            'div',
            { class: 'min-w-0' },
            h('p', { class: 'text-lg font-semibold text-content', text: row.name }),
            h('p', {
              class: 'text-xs text-content-muted',
              text: row.phone || 'No phone number',
            })
          ),
          badge(aging.label, { tone: aging.tone, iconName: 'schedule' })
        ),

        // The headline figure, given the room it deserves.
        card(
          h(
            'div',
            { class: 'flex items-center justify-between gap-3' },
            h(
              'div',
              null,
              h('p', { class: 'text-xs font-medium text-content-muted', text: 'Owed to the shop' }),
              h('p', {
                class: 'mt-0.5 text-2xl font-semibold tabular-nums text-content',
                text: money(row.balance),
              })
            ),
            icon('account_balance_wallet', 'text-3xl text-content-subtle')
          )
        ),

        // The ledger behind the figure.
        card(
          h(
            'div',
            { class: 'divide-y divide-border' },
            field('Open invoices', String(row.invoices)),
            field('Oldest sale', row.oldest ? row.oldest.slice(0, 10) : '—'),
            field(
              'Days waiting',
              row.days === null ? '—' : `${row.days} day${row.days === 1 ? '' : 's'}`
            ),
            field('Share of the book', `${row.share.toFixed(1)}%`),
            field('Credit limit', row.limit === null ? 'No limit set' : money(row.limit)),
            field(
              'Limit used',
              row.used === null ? '—' : `${row.used.toFixed(1)}%`,
              row.used !== null && row.used >= 100 ? 'text-danger' : 'text-content'
            )
          )
        )
      )
    )
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  function drawStats(): void {
    const stats = bookStats(allRows)
    const money = (value: number): string => formatMoney(minor(value), { currency })
    mount(
      statsSlot,
      h(
        'div',
        { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' },
        card(stat('Owed to the shop', money(stats.totalMinor), { iconName: 'menu_book' })),
        card(
          stat('In the book', String(stats.debtors), {
            iconName: 'group',
            hint: stats.debtors === 0 ? 'Nobody owes anything.' : `avg ${money(stats.averageMinor)} each`,
          })
        ),
        card(
          stat('Stale (30d+)', money(stats.buckets.stale.totalMinor), {
            iconName: 'hourglass_bottom',
            hint: `${stats.buckets.stale.count} customer(s)`,
          })
        ),
        card(
          stat(
            'Oldest debt',
            stats.oldestDays === null ? '—' : `${stats.oldestDays}d`,
            { iconName: 'history', hint: 'days since that sale' }
          )
        )
      )
    )
  }

  function drawToolbar(): void {
    const chips = AGE_FILTERS.map((filter) =>
      h('button', {
        type: 'button',
        class:
          'rounded-full border px-3 py-1 text-xs transition-colors ' +
          (ageFilter === filter.key
            ? 'border-primary bg-primary text-primary-contrast'
            : 'border-border bg-surface text-content-muted hover:text-content'),
        text: filter.label,
        onclick: () => {
          ageFilter = filter.key
          drawToolbar()
          drawTable()
        },
      })
    )
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
    mount(
      toolbarSlot,
      h(
        'div',
        { class: 'flex flex-wrap items-center justify-between gap-2' },
        h('div', { class: 'flex flex-wrap items-center gap-1.5' }, ...chips),
        h(
          'div',
          { class: 'flex flex-wrap items-center gap-1.5' },
          tool('CSV', 'download', exportCsv),
          tool('Image', 'image', () => void exportImage()),
          tool('PDF / Print', 'picture_as_pdf', exportPdf),
          tool('Copy', 'content_copy', () => void copyBook())
        )
      )
    )
  }

  function drawTable(): void {
    const rows = visibleRows()
    if (rows.length === 0) {
      mount(
        tableSlot,
        emptyState(
          search || ageFilter !== 'all' ? 'Nobody matching that owes anything' : 'The book is clean',
          {
            description:
              search || ageFilter !== 'all'
                ? 'Try another name, phone number or age bucket.'
                : 'A sale taken partly or fully on credit appears here, under the customer’s name.',
            iconName: 'menu_book',
          }
        )
      )
      return
    }
    mount(
      tableSlot,
      card(
        dataTable({
          columns: DUE_COLUMNS,
          rows,
          totals: { balance: rows.reduce((sum, row) => sum + row.balance, 0) },
          currency,
          sort: sortKey,
          dir: sortDir,
          onSort: (key) => {
            if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
            else {
              sortKey = key
              // Numbers open big-first; names open A-first.
              sortDir = key === 'name' || key === 'phone' ? 'asc' : 'desc'
            }
            drawTable()
          },
          // A row is a question; the modal is the answer, opened in place.
          onRowClick: (reportRow) => openDueDetail(reportRow as DebtorRow),
          pageSize: 50,
          emptyTitle: 'The book is clean',
        })
      )
    )
  }

  async function reload(): Promise<void> {
    if (!loaded) mount(tableSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    let book: DueBook
    try {
      book = await db.rpc<DueBook>('book', search ? { search } : {})
    } catch (error) {
      mount(
        tableSlot,
        h('p', {
          class: 'rounded-lg border border-border bg-surface p-4 text-sm text-danger',
          text: error instanceof Error ? error.message : 'The due book could not be read.',
        })
      )
      return
    }
    loaded = true
    allRows = toRows(book)
    drawStats()
    drawToolbar()
    drawTable()
  }

  root.append(
    searchInput('Search the book by name or phone…', (value) => {
      search = value.trim()
      void reload()
    }),
    statsSlot,
    toolbarSlot,
    noticeSlot,
    tableSlot
  )
  void reload()
  return root
}
