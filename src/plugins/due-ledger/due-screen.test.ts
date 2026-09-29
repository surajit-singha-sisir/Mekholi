/**
 * The due book screen, wired to a fake bridge.
 *
 * What must hold: the book renders as the universal table with a header
 * cell per column, the headline cards show real money, clicking a header
 * re-sorts client-side without another server call, the age chips filter
 * rows, and a broken bridge is an apology on screen — never a blank page.

 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createDueScreen } from './due-screen'
import { DUE_COLUMNS, type DueBook } from './due-model'
import type { PluginDb } from '../../shared/registry/plugin-types'

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
      oldest_due_at: '2026-08-15T10:00:00+06:00',
    },
    {
      id: 'b',
      name: 'Rahima',
      phone: null,
      balance_minor: 100000,
      credit_limit_minor: 0,
      open_sales: 1,
      oldest_due_at: '2026-09-18T10:00:00+06:00',
    },
    {
      id: 'c',
      name: 'Anwar',
      phone: '01822222222',
      balance_minor: 50000,
      credit_limit_minor: 100000,
      open_sales: 2,
      oldest_due_at: '2026-09-26T10:00:00+06:00',
    },
  ],
}

function fakeDb(book: DueBook = BOOK): { db: PluginDb; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    db: {
      products: () => Promise.resolve([]),
      rpc: <T>() => {
        calls.push(Date.now())
        return Promise.resolve(book as T)
      },
    },
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function rowNames(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('tbody td[data-column="name"]')).map(
    (cell) => cell.textContent ?? ''
  )
}

describe('due screen', () => {
  // The detail modal mounts on document.body, so clear it between cases.
  afterEach(() => document.body.replaceChildren())

  it('renders the whole ledger in the universal table, biggest due first', async () => {
    const { db } = fakeDb()
    const root = createDueScreen({ db, currency: 'BDT' })
    await settle()

    // Header cells also carry the sort icon's ligature text; match the start.
    const headers = Array.from(root.querySelectorAll('th')).map((th) => th.textContent?.trim() ?? '')
    for (const column of DUE_COLUMNS) {
      expect(headers.some((header) => header.startsWith(column.label))).toBe(true)
    }
    expect(rowNames(root)).toEqual(['Karim', 'Rahima', 'Anwar'])
    expect(root.textContent).toContain('Owed to the shop')
    expect(root.textContent).toContain('Stale (30d+)')
  })

  it('re-sorts on a header click without asking the server again', async () => {
    const { db, calls } = fakeDb()
    const root = createDueScreen({ db, currency: 'BDT' })
    await settle()
    const callsAfterLoad = calls.length

    const nameHeader = Array.from(root.querySelectorAll('th')).find((th) =>
      th.textContent?.trim().startsWith('Customer')
    )!
    nameHeader.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(rowNames(root)).toEqual(['Anwar', 'Karim', 'Rahima'])
    expect(calls.length).toBe(callsAfterLoad)
  })

  it('filters by age bucket through the chips', async () => {
    const { db } = fakeDb()
    const root = createDueScreen({ db, currency: 'BDT' })
    await settle()

    const stale = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Stale')
    )!
    stale.click()
    expect(rowNames(root)).toEqual(['Karim'])

    const all = Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'All'
    )!
    all.click()
    expect(rowNames(root)).toHaveLength(3)
  })

  it('offers all four exports', async () => {
    const { db } = fakeDb()
    const root = createDueScreen({ db, currency: 'BDT' })
    await settle()
    const labels = Array.from(root.querySelectorAll('button')).map(
      (button) => button.getAttribute('aria-label') ?? button.textContent?.trim()
    )
    expect(labels).toContain('CSV')
    expect(labels).toContain('Image')
    expect(labels).toContain('PDF / Print')
    expect(labels).toContain('Copy')
  })

  it('shows the apology, not a blank page, when the bridge refuses', async () => {
    const db: PluginDb = {
      products: () => Promise.resolve([]),
      rpc: () => Promise.reject(new Error('The plugin is not enabled for this shop.')),
    }
    const root = createDueScreen({ db, currency: 'BDT' })
    await settle()
    expect(root.textContent).toContain('The plugin is not enabled for this shop.')
  })

  it('opens a due detail modal on row click instead of navigating away', async () => {
    const { db } = fakeDb()
    const navigated: string[] = []
    const root = createDueScreen({ db, currency: 'BDT', go: (to) => navigated.push(to) })
    document.body.append(root)
    await settle()

    const firstRow = root.querySelector('tbody td[data-column="name"]') as HTMLElement
    firstRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    // The click opens the detail — it must NOT leave the book.
    expect(navigated).toEqual([])

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Due details')
    expect(dialog.textContent).toContain('Karim')
    expect(dialog.textContent).toContain('Open invoices')
    expect(dialog.textContent).toContain('Share of the book')

    // The one action that changes money lives on the customer card.
    const openButton = Array.from(dialog.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Open customer card')
    ) as HTMLButtonElement
    expect(openButton).toBeTruthy()
    openButton.click()
    expect(navigated).toEqual(['/customers'])
  })
})
