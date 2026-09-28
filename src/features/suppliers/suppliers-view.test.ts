/**
 * The supplier book: the table, the totals, and the grown-up card.
 *
 * What must hold: the universal table shows every supplier with a due/settled
 * status and the owed total; the add form carries the trade-book fields
 * (contact person, terms, BIN, bank, wallet) into metadata; and an edit
 * merges over existing metadata rather than wiping keys it does not own.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupplierRow } from '../../shared/repositories/contracts'
import type { Minor } from '../../shared/domain/money'

const SUPPLIERS: SupplierRow[] = [
  {
    id: 's-1',
    name: 'Karim Wholesale',
    phone: '01711000000',
    email: null,
    address: 'Bandar Bazar, Sylhet',
    note: null,
    balance: 50_000 as Minor, // we owe ৳500.00
    metadata: { contact_person: 'Karim Uddin', payment_terms: 'net15', supplies: 'rice, oil', someday_key: 'kept' },
    createdAt: '2026-09-01T10:00:00+06:00',
    updatedAt: '2026-09-01T10:00:00+06:00',
  },
  {
    id: 's-2',
    name: 'Fresh Dairy',
    phone: null,
    email: 'dairy@example.com',
    address: null,
    note: null,
    balance: 0 as Minor,
    metadata: {},
    createdAt: '2026-09-02T10:00:00+06:00',
    updatedAt: '2026-09-02T10:00:00+06:00',
  },
]

const createMock = vi.fn(async (draft: unknown) => ({ ...SUPPLIERS[1]!, ...(draft as object) }))
const updateMock = vi.fn(async (_id: string, draft: unknown) => ({ ...SUPPLIERS[0]!, ...(draft as object) }))

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    suppliers: {
      list: () => Promise.resolve({ items: SUPPLIERS, nextCursor: null }),
      get: (id: string) => Promise.resolve(SUPPLIERS.find((s) => s.id === id) ?? null),
      create: createMock,
      update: updateMock,
      purchases: () => Promise.resolve({ items: [], nextCursor: null }),
    },
    catalog: { listPaymentMethods: () => Promise.resolve([]) },
  }),
}))

vi.mock('../../app/state/session', () => ({
  can: () => true,
  activeOrganization: () => ({ organization_id: 'org-1', name: 'Test Shop', currency: 'BDT' }),
}))

import { suppliersView } from './suppliers-view'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ''
  createMock.mockClear()
  updateMock.mockClear()
})

describe('suppliers view', () => {
  it('the table carries the trade columns, the dues and the owed total', async () => {
    const view = suppliersView()
    document.body.append(view)
    await settle()

    const text = view.textContent ?? ''
    expect(text).toContain('Karim Wholesale')
    expect(text).toContain('Karim Uddin') // contact person out of metadata
    expect(text).toContain('Net 15 days') // terms as words, not a key
    expect(text).toContain('500.00') // the balance and the owed summary
    expect(text).toContain('due')
    expect(text).toContain('settled')
    expect(text).toContain('We owe')
  })

  it('a new supplier saves the whole card into metadata', async () => {
    const view = suppliersView()
    document.body.append(view)
    await settle()

    const addButton = [...view.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('Add')
    )
    addButton?.click()
    await settle()

    const set = (id: string, value: string): void => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
      if (el) el.value = value
    }
    set('supplier-name', 'New Trader')
    set('supplier-contact', 'Mr. Rahim')
    set('supplier-terms', 'cod')
    set('supplier-bin', '001234567-0101')
    set('supplier-bank', 'City Bank, Zindabazar')
    set('supplier-account', '123456')
    set('supplier-wallet', '01899999999')
    set('supplier-lead', '3')

    const submit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('Add supplier')
    )
    submit?.click()
    await settle()

    expect(createMock).toHaveBeenCalledTimes(1)
    const draft = createMock.mock.calls[0]?.[0] as { name: string; metadata: Record<string, unknown> }
    expect(draft.name).toBe('New Trader')
    expect(draft.metadata).toMatchObject({
      contact_person: 'Mr. Rahim',
      payment_terms: 'cod',
      bin: '001234567-0101',
      bank_name: 'City Bank, Zindabazar',
      bank_account: '123456',
      wallet_number: '01899999999',
      lead_time_days: '3',
    })
  })

  it('editing merges over metadata instead of wiping foreign keys', async () => {
    const view = suppliersView()
    document.body.append(view)
    await settle()

    // Open the detail for Karim, then its Edit button.
    const row = [...view.querySelectorAll<HTMLElement>('tbody tr')].find((tr) =>
      (tr.textContent ?? '').includes('Karim Wholesale')
    )
    row?.click()
    await settle()

    const edit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.textContent ?? '').trim().includes('Edit')
    )
    edit?.click()
    await settle()

    const contact = document.getElementById('supplier-contact') as HTMLInputElement
    expect(contact.value).toBe('Karim Uddin') // the form reads the card back
    contact.value = 'Karim Jr.'

    const submit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('Save changes')
    )
    submit?.click()
    await settle()

    expect(updateMock).toHaveBeenCalledTimes(1)
    const draft = updateMock.mock.calls[0]?.[1] as { metadata: Record<string, unknown> }
    expect(draft.metadata['contact_person']).toBe('Karim Jr.')
    // A key this form does not own survives the edit untouched.
    expect(draft.metadata['someday_key']).toBe('kept')
  })
})
