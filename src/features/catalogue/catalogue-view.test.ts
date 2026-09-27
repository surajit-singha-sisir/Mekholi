/**
 * The catalogue screen: the tree, the counts, and the modal table.
 *
 * What must hold: a parent category's badge rolls up its descendants'
 * products while the child rows keep their own counts, sub-categories
 * render indented under their parents, tapping a row opens a modal whose
 * table carries the products of the whole subtree, and the brand list
 * counts its products too.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Category, ProductRow } from '../../shared/types/records'

const CATEGORIES: Category[] = [
  { id: 'c-bev', name: 'Beverages', slug: 'beverages', parent_id: null, sort_order: 0, is_active: true },
  { id: 'c-tea', name: 'Tea', slug: 'tea', parent_id: 'c-bev', sort_order: 0, is_active: true },
  { id: 'c-soap', name: 'Soap', slug: 'soap', parent_id: null, sort_order: 1, is_active: true },
]

function product(id: string, name: string, categoryId: string | null): ProductRow {
  return {
    id,
    organization_id: 'org-1',
    name,
    sku: `SKU-${id}`,
    description: null,
    category_id: categoryId,
    brand_id: id === 'p-1' ? 'b-1' : null,
    unit_id: null,
    tax_id: null,
    selling_price: '150.00',
    cost_price: '100.00',
    tax_inclusive: false,
    reorder_point: '0',
    track_stock: true,
    allow_negative: false,
    is_active: true,
    image_url: null,
    metadata: {},
    created_at: '2026-09-01T10:00:00+06:00',
  }
}

const PRODUCTS = [
  product('p-1', 'Cola', 'c-bev'),
  product('p-2', 'Green tea', 'c-tea'),
  product('p-3', 'Black tea', 'c-tea'),
  product('p-4', 'Bar soap', 'c-soap'),
]

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    catalog: {
      listCategories: () => Promise.resolve(CATEGORIES),
      listBrands: () => Promise.resolve([{ id: 'b-1', name: 'Fresh', slug: 'fresh', is_active: true }]),
    },
    products: {
      list: () => Promise.resolve({ items: PRODUCTS, nextCursor: null }),
    },
  }),
}))

vi.mock('../../app/state/session', () => ({
  can: () => true,
  activeOrganization: () => ({ name: 'Rahim Store', currency: 'BDT' }),
}))

import { catalogueView } from './catalogue-view'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  document.body.replaceChildren()
})

describe('catalogue view', () => {
  it('rolls the parent count up and keeps the child count honest', async () => {
    const root = catalogueView()
    document.body.appendChild(root)
    await settle()

    const beverages = Array.from(root.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label')?.startsWith('Beverages')
    )!
    const tea = Array.from(root.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label')?.startsWith('Tea')
    )!
    expect(beverages.textContent).toContain('3 products') // Cola + both teas
    expect(beverages.textContent).toContain('1 sub-category')
    expect(tea.textContent).toContain('2 products')
  })

  it('opens a modal table carrying the whole subtree of products', async () => {
    const root = catalogueView()
    document.body.appendChild(root)
    await settle()

    Array.from(root.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label')?.startsWith('Beverages'))!
      .click()
    await settle()

    const table = document.body.querySelector('table')!
    expect(table).not.toBeNull()
    expect(table.textContent).toContain('Cola')
    expect(table.textContent).toContain('Green tea') // from the Tea sub-category
    expect(table.textContent).not.toContain('Bar soap')
    expect(document.body.textContent).toContain('3 products, sub-categories included.')
  })

  it('counts brand products in the brands tab', async () => {
    const root = catalogueView()
    document.body.appendChild(root)
    await settle()

    Array.from(root.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Brands')!
      .click()
    await settle()

    expect(root.textContent).toContain('Fresh')
    expect(root.textContent).toContain('1 product')
  })
})
