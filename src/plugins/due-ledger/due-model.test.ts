/**
 * The due book's arithmetic.
 *
 * What must hold: aging buckets break at a week and a month, derived
 * shares and utilisation are honest percentages, every column sorts by
 * its own type with empties sinking to the bottom, the headline stats
 * add up, and all four export shapes carry the same columns in the same
 * order — CSV as machine numbers, print/clipboard as eye numbers.
 */

import { describe, expect, it } from 'vitest'
import { parseCsv } from '../../shared/export/csv'
import {
  DUE_COLUMNS,
  agingOf,
  bookStats,
  cellDisplay,
  daysWaiting,
  dueClipboardText,
  dueCsv,
  duePrintHtml,
  sortRows,
  toRows,
  type DueBook,
} from './due-model'

const NOW = Date.parse('2026-09-28T12:00:00+06:00')

const BOOK: DueBook = {
  total_due_minor: 400000,
  debtor_count: 3,
  debtors: [
    {
      id: 'a',
      name: 'Karim',
      phone: '01711111111',
      balance_minor: 250000,
      credit_limit_minor: 500000,
      open_sales: 3,
      oldest_due_at: '2026-08-15T10:00:00+06:00', // 44 days → stale
    },
    {
      id: 'b',
      name: 'Rahima',
      phone: null,
      balance_minor: 100000,
      credit_limit_minor: 0,
      open_sales: 1,
      oldest_due_at: '2026-09-18T10:00:00+06:00', // 10 days → aging
    },
    {
      id: 'c',
      name: 'Anwar',
      phone: '01822222222',
      balance_minor: 50000,
      credit_limit_minor: 100000,
      open_sales: 2,
      oldest_due_at: '2026-09-26T10:00:00+06:00', // 2 days → fresh
    },
  ],
}

describe('aging', () => {
  it('breaks at a week and a month', () => {
    expect(agingOf(null)).toBe('fresh')
    expect(agingOf(0)).toBe('fresh')
    expect(agingOf(6)).toBe('fresh')
    expect(agingOf(7)).toBe('aging')
    expect(agingOf(30)).toBe('aging')
    expect(agingOf(31)).toBe('stale')
  })

  it('counts whole days and never goes negative', () => {
    expect(daysWaiting('2026-09-18T10:00:00+06:00', NOW)).toBe(10)
    expect(daysWaiting('2099-01-01T00:00:00+06:00', NOW)).toBe(0)
    expect(daysWaiting(null, NOW)).toBeNull()
    expect(daysWaiting('not a date', NOW)).toBeNull()
  })
})

describe('toRows', () => {
  it('derives share, utilisation and bucket per debtor', () => {
    const rows = toRows(BOOK, NOW)
    const karim = rows[0]!
    expect(karim.share).toBe(62.5) // 250000 of 400000
    expect(karim.used).toBe(50) // 250000 of 500000
    expect(karim.days).toBe(44)
    expect(karim.aging).toBe('stale')

    const rahima = rows[1]!
    expect(rahima.phone).toBe('') // null phone renders as empty, not "null"
    expect(rahima.limit).toBeNull() // zero limit means "no limit set"
    expect(rahima.used).toBeNull()
    expect(rahima.aging).toBe('aging')

    expect(rows[2]!.aging).toBe('fresh')
  })
})

describe('sortRows', () => {
  const rows = toRows(BOOK, NOW)

  it('sorts money numerically both ways', () => {
    expect(sortRows(rows, 'balance', 'desc').map((r) => r.name)).toEqual(['Karim', 'Rahima', 'Anwar'])
    expect(sortRows(rows, 'balance', 'asc').map((r) => r.name)).toEqual(['Anwar', 'Rahima', 'Karim'])
  })

  it('sorts names as text', () => {
    expect(sortRows(rows, 'name', 'asc').map((r) => r.name)).toEqual(['Anwar', 'Karim', 'Rahima'])
  })

  it('sorts dates by instant, not by string', () => {
    expect(sortRows(rows, 'oldest', 'asc')[0]!.name).toBe('Karim')
  })

  it('ranks age buckets by urgency with stale first on desc', () => {
    expect(sortRows(rows, 'aging', 'asc').map((r) => r.aging)).toEqual(['stale', 'aging', 'fresh'])
  })

  it('sinks empty cells to the bottom whichever way the column points', () => {
    expect(sortRows(rows, 'used', 'desc').at(-1)!.name).toBe('Rahima')
    expect(sortRows(rows, 'used', 'asc').at(-1)!.name).toBe('Rahima')
  })

  it('returns a copy for an unknown key rather than throwing', () => {
    expect(sortRows(rows, 'nope', 'asc')).toHaveLength(3)
  })
})

describe('bookStats', () => {
  it('adds up totals, average and buckets', () => {
    const stats = bookStats(toRows(BOOK, NOW))
    expect(stats.totalMinor).toBe(400000)
    expect(stats.debtors).toBe(3)
    expect(stats.averageMinor).toBe(133333)
    expect(stats.oldestDays).toBe(44)
    expect(stats.buckets.stale).toEqual({ count: 1, totalMinor: 250000 })
    expect(stats.buckets.aging).toEqual({ count: 1, totalMinor: 100000 })
    expect(stats.buckets.fresh).toEqual({ count: 1, totalMinor: 50000 })
  })

  it('survives an empty book', () => {
    const stats = bookStats([])
    expect(stats.averageMinor).toBe(0)
    expect(stats.oldestDays).toBeNull()
  })
})

describe('exports', () => {
  const rows = sortRows(toRows(BOOK, NOW), 'balance', 'desc')

  it('CSV carries every column, money in major units, and re-parses', () => {
    const csv = dueCsv(rows)
    const parsed = parseCsv(csv.replace(/^\uFEFF/, ''))
    expect(parsed[0]).toEqual(DUE_COLUMNS.map((column) => column.label))
    expect(parsed).toHaveLength(4)
    const karim = parsed[1]!
    expect(karim[0]).toBe('Karim')
    expect(karim[2]).toBe('2500') // minor 250000 → major, plain decimal
    expect(karim[5]).toBe('2026-08-15')
    expect(karim[9]).toBe('stale')
  })

  it('cellDisplay formats for the eye and dashes what is missing', () => {
    const karim = rows[0]!
    expect(cellDisplay(karim, 'balance', 'BDT')).toContain('2,500')
    expect(cellDisplay(karim, 'used', 'BDT')).toBe('50.0%')
    const rahima = rows.find((r) => r.name === 'Rahima')!
    expect(cellDisplay(rahima, 'phone', 'BDT')).toBe('—')
    expect(cellDisplay(rahima, 'limit', 'BDT')).toBe('—')
  })

  it('print HTML holds the headline, every row, and escapes what customers type', () => {
    const spiky = toRows(
      { ...BOOK, debtors: [{ ...BOOK.debtors[0]!, name: '<b>Karim</b>' }] },
      NOW
    )
    const html = duePrintHtml(spiky, 'BDT', 'Mekholi')
    expect(html).toContain('&lt;b&gt;Karim&lt;/b&gt;')
    expect(html).not.toContain('<b>Karim</b>')
    expect(html).toContain('বাকির খাতা')
    expect(duePrintHtml(rows, 'BDT', 'Mekholi').match(/<tr>/g)).toHaveLength(5) // head + 3 rows + totals
  })

  it('clipboard text is tab-separated with the same column order', () => {
    const text = dueClipboardText(rows, 'BDT')
    const lines = text.split('\n')
    expect(lines[0]!.split('\t')).toEqual(DUE_COLUMNS.map((column) => column.label))
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('Karim')
  })
})
