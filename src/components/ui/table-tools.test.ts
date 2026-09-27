/**
 * The table's finishing tools.
 *
 * What must hold: the sorter respects each column's type (money numeric,
 * dates by instant, text by locale) and never lets an empty cell win;
 * the export toolbar offers all four ways out and builds its CSV from
 * machine values — money in major units, dates as ISO days — while the
 * clipboard and picture carry the same strings the table cells show.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import { exportToolbar, sortReportRows } from './table-tools'
import { parseCsv } from '../../shared/export/csv'
import * as download from '../../shared/export/download'
import type { ReportCell, ReportColumn } from '../../shared/repositories/contracts'

const COLUMNS: readonly ReportColumn[] = [
  { key: 'name', label: 'Customer', type: 'text' },
  { key: 'due', label: 'Due', type: 'money', align: 'right' },
  { key: 'added', label: 'Added', type: 'date' },
]

const ROWS: Record<string, ReportCell>[] = [
  { name: 'Karim', due: 250000, added: '2026-08-15T10:00:00+06:00' },
  { name: 'Anwar', due: 50000, added: '2026-09-26T10:00:00+06:00' },
  { name: 'Rahima', due: null, added: '2026-09-02T10:00:00+06:00' },
]

describe('sortReportRows', () => {
  it('sorts money numerically', () => {
    expect(sortReportRows(COLUMNS, ROWS, 'due', 'desc').map((r) => r['name'])).toEqual(['Karim', 'Anwar', 'Rahima'])
  })

  it('sinks empty cells whichever way the column points', () => {
    expect(sortReportRows(COLUMNS, ROWS, 'due', 'asc').at(-1)!['name']).toBe('Rahima')
    expect(sortReportRows(COLUMNS, ROWS, 'due', 'desc').at(-1)!['name']).toBe('Rahima')
  })

  it('sorts dates by instant and text by locale', () => {
    expect(sortReportRows(COLUMNS, ROWS, 'added', 'asc')[0]!['name']).toBe('Karim')
    expect(sortReportRows(COLUMNS, ROWS, 'name', 'asc').map((r) => r['name'])).toEqual(['Anwar', 'Karim', 'Rahima'])
  })

  it('returns a copy for an unknown key rather than throwing', () => {
    expect(sortReportRows(COLUMNS, ROWS, 'nope', 'asc')).toHaveLength(3)
  })
})

describe('exportToolbar', () => {
  const options = {
    title: 'Customers',
    filename: 'customers',
    columns: COLUMNS,
    currency: 'BDT',
    rows: () => ROWS,
    subtitle: () => '3 customers',
    onNotice: () => undefined,
  }

  it('offers all four ways out', () => {
    const toolbar = exportToolbar(options)
    const labels = Array.from(toolbar.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['CSV', 'Image', 'PDF / Print', 'Copy'])
  })

  it('CSV leaves with machine values: major-unit money, ISO days, blank nulls', () => {
    let saved = ''
    const spy = vi.spyOn(download, 'downloadText').mockImplementation((_name, content) => {
      saved = content
      return { ok: true }
    })
    try {
      const toolbar = exportToolbar(options)
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="CSV"]')!.click()
      const parsed = parseCsv(saved.replace(/^\uFEFF/, ''))
      expect(parsed[0]).toEqual(['Customer', 'Due', 'Added'])
      expect(parsed[1]).toEqual(['Karim', '2500', '2026-08-15'])
      expect(parsed[3]![1]).toBe('') // null due is an empty field, not "null"
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('the clipboard carries the same strings the table cells show', async () => {
    const written: string[] = []
    Object.assign(navigator, { clipboard: { writeText: (t: string) => (written.push(t), Promise.resolve()) } })
    const toolbar = exportToolbar(options)
    toolbar.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click()
    await new Promise((r) => setTimeout(r, 0))
    const lines = written[0]!.split('\n')
    expect(lines[0]).toBe('Customer\tDue\tAdded')
    expect(lines[1]).toContain('Karim')
    expect(lines[1]).toContain('2,500') // eye money, not machine money
    expect(lines[3]).toContain('—') // the null renders as the same dash the cell shows
  })
})
