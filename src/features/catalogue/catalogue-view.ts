/**
 * Catalogue management: categories and brands.
 *
 * The product form has a searchable inline creator for speed at the till. This
 * screen is the slower, deliberate place to review the catalogue vocabulary,
 * add defaults that were not seeded, and keep brand names consistent.
 *
 * Categories are drawn as the tree they are (parents with their
 * sub-categories indented under them), and every row carries its product
 * count — a parent's count rolls up its descendants, because "Beverages: 12"
 * should mean twelve things a customer could call a beverage, not four that
 * happen to sit on the parent node. Tapping a row opens the products
 * themselves in a modal table, sortable and exportable like every other
 * table in the app.
 */

import { h, icon, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { badge, emptyState } from '../../components/ui/card'
import { field, input, select } from '../../components/ui/input'
import { dataTable } from '../../components/ui/table'
import { exportToolbar, sortReportRows } from '../../components/ui/table-tools'
import { modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { activeOrganization, can } from '../../app/state/session'
import { translateError } from '../../app/platform/errors'
import { minor, parseMinor } from '../../shared/domain/money'
import type { Brand, Category, ProductRow } from '../../shared/types/records'
import type { ReportCell, ReportColumn } from '../../shared/repositories/contracts'

type CatalogueMode = 'categories' | 'brands'

/** The modal's columns — screen, CSV, picture and printout alike (§23). */
const PRODUCT_COLUMNS: readonly ReportColumn[] = [
  { key: 'name', label: 'Product', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'price', label: 'Price', type: 'money', align: 'right' },
  { key: 'active', label: 'Status', type: 'text' },
  { key: 'added', label: 'Added', type: 'date' },
]

export function catalogueView(): HTMLElement {
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'
  let mode: CatalogueMode = 'categories'
  let search = ''
  let categories: Category[] = []
  let brands: Brand[] = []
  let products: ProductRow[] = []
  let loading = false

  const root = h('div', { class: 'flex w-full min-w-0 flex-col p-4' })
  const listSlot = h('div', { class: '' })
  const searchInput = input({
    type: 'search',
    placeholder: 'Search…',
    onInput: (value) => {
      search = value
      renderList()
    },
  })
  const categoriesButton = button('Categories', {
    variant: 'primary',
    onClick: () => {
      mode = 'categories'
      searchInput.value = ''
      search = ''
      render()
    },
  })
  const brandsButton = button('Brands', {
    variant: 'outline',
    onClick: () => {
      mode = 'brands'
      searchInput.value = ''
      search = ''
      render()
    },
  })
  const addButton = button('Add category', {
    variant: 'primary',
    icon: 'add',
    onClick: () => openAdd(),
  })

  function render(): void {
    categoriesButton.className = categoriesButton.className
      .replace(/bg-primary|text-white|border-primary/g, '')
      .replace(/bg-surface|text-content|border-border/g, '')
    brandsButton.className = brandsButton.className
      .replace(/bg-primary|text-white|border-primary/g, '')
      .replace(/bg-surface|text-content|border-border/g, '')
    // Keep the shared button styling and only change the visual emphasis by
    // using the button variants through a small label class toggle.
    categoriesButton.classList.toggle('bg-primary', mode === 'categories')
    categoriesButton.classList.toggle('text-white', mode === 'categories')
    brandsButton.classList.toggle('bg-primary', mode === 'brands')
    brandsButton.classList.toggle('text-white', mode === 'brands')
    addButton.textContent = mode === 'categories' ? 'Add category' : 'Add brand'
    renderList()
  }

  // ── The tree and its arithmetic ─────────────────────────────────────

  function childrenOf(id: string): Category[] {
    return categories
      .filter((item) => item.parent_id === id)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  }

  /** This category and every descendant — what a tap on the row means. */
  function familyIds(category: Category): Set<string> {
    const ids = new Set<string>([category.id])
    const walk = (id: string): void => {
      for (const child of childrenOf(id)) {
        ids.add(child.id)
        walk(child.id)
      }
    }
    walk(category.id)
    return ids
  }

  function rollupCount(category: Category): number {
    let n = 0
    const ids = familyIds(category)
    for (const product of products) if (product.category_id && ids.has(product.category_id)) n += 1
    return n
  }

  /** A category matches when it, or anything under it, matches. */
  function subtreeMatches(category: Category, needle: string): boolean {
    if (category.name.toLowerCase().includes(needle)) return true
    return childrenOf(category.id).some((child) => subtreeMatches(child, needle))
  }

  function categoryRow(category: Category, depth: number): HTMLElement[] {
    const kids = childrenOf(category.id)
    const count = rollupCount(category)
    const row = h(
      'button',
      {
        type: 'button',
        class:
          'flex w-full min-h-14 items-center justify-between gap-3 px-4 py-3 text-left ' +
          'hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        onclick: () => openCategoryProducts(category),
        'aria-label': `${category.name}: ${count} product${count === 1 ? '' : 's'}`,
      },
      h(
        'div',
        { class: 'flex min-w-0 items-center gap-2', style: depth > 0 ? `padding-left:${depth * 1.5}rem` : '' },
        depth > 0 ? icon('subdirectory_arrow_right', 'text-base text-content-subtle') : icon('folder', 'text-base text-content-subtle'),
        h(
          'div',
          { class: 'min-w-0' },
          h('p', { class: 'truncate font-medium text-content', text: category.name }),
          h('p', {
            class: 'truncate text-xs text-content-muted',
            text:
              kids.length > 0
                ? `${category.slug} · ${kids.length} sub-categor${kids.length === 1 ? 'y' : 'ies'}`
                : category.slug,
          })
        )
      ),
      h(
        'div',
        { class: 'flex shrink-0 items-center gap-2' },
        badge(`${count} product${count === 1 ? '' : 's'}`, { tone: count > 0 ? 'info' : 'neutral' }),
        icon('chevron_right', 'text-base text-content-subtle')
      )
    )
    return [row, ...kids.flatMap((child) => categoryRow(child, depth + 1))]
  }

  function renderList(): void {
    if (loading) {
      mount(listSlot, h('div', { class: 'flex justify-center p-8' }, spinner()))
      return
    }
    const needle = search.trim().toLowerCase()
    if (mode === 'categories') {
      const topLevel = categories
        .filter((item) => item.parent_id === null)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
        .filter((item) => !needle || subtreeMatches(item, needle))
      // Orphans (parent deleted or not loaded) still deserve a row.
      const orphans = categories.filter(
        (item) => item.parent_id !== null && !categories.some((parent) => parent.id === item.parent_id)
      )
      const roots = [...topLevel, ...orphans.filter((item) => !needle || subtreeMatches(item, needle))]
      mount(
        listSlot,
        roots.length > 0
          ? h(
              'div',
              { class: 'divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface' },
              ...roots.flatMap((item) => categoryRow(item, 0))
            )
          : emptyState(needle ? 'No categories match' : 'No categories yet', {
              description: 'Add a category here or create one directly from the Add Product form.',
              iconName: 'category',
            })
      )
      return
    }

    const rows = brands.filter((item) => item.name.toLowerCase().includes(needle))
    mount(
      listSlot,
      rows.length > 0
        ? h(
            'div',
            { class: 'divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface' },
            ...rows.map((item) => {
              const count = products.filter((product) => product.brand_id === item.id).length
              return h(
                'div',
                { class: 'flex min-h-14 items-center justify-between gap-3 px-4 py-3' },
                h('p', { class: 'truncate font-medium text-content', text: item.name }),
                badge(`${count} product${count === 1 ? '' : 's'}`, { tone: count > 0 ? 'info' : 'neutral' })
              )
            })
          )
        : emptyState(needle ? 'No brands match' : 'No brands yet', {
            description: 'Add a brand here or create one directly from the Add Product form.',
            iconName: 'sell',
          })
    )
  }

  // ── The products behind a row, in a modal table ─────────────────────

  function openCategoryProducts(category: Category): void {
    const ids = familyIds(category)
    const names = new Map(categories.map((item) => [item.id, item.name]))
    const rows: Record<string, ReportCell>[] = products
      .filter((product) => product.category_id !== null && ids.has(product.category_id))
      .map((product) => ({
        name: product.name,
        sku: product.sku,
        category: names.get(product.category_id ?? '') ?? '—',
        price: Number(parseMinor(product.selling_price) ?? minor(0)),
        active: product.is_active ? 'Active' : 'Inactive',
        added: product.created_at,
      }))

    let sortKey = 'name'
    let sortDir: 'asc' | 'desc' = 'asc'

    const dialog = modal({
      title: category.name,
      subtitle: `${rows.length} product${rows.length === 1 ? '' : 's'}, sub-categories included.`,
      iconName: 'category',
      size: 'xl',
    })

    const visible = (): Record<string, ReportCell>[] => sortRows()
    function sortRows(): Record<string, ReportCell>[] {
      return sortReportRows(PRODUCT_COLUMNS, rows, sortKey, sortDir)
    }

    function draw(): void {
      const toolbar = exportToolbar({
        title: `${category.name} — products`,
        filename: category.slug || 'category-products',
        columns: PRODUCT_COLUMNS,
        currency,
        rows: visible,
        subtitle: () => `${rows.length} product${rows.length === 1 ? '' : 's'}`,
        footerNote: activeOrganization()?.name ?? 'Mekholi POS',
        onNotice: (message, bad) => (bad ? toastError(message) : toastSuccess(message)),
      })
      mount(
        dialog.body,
        h(
          'div',
          { class: 'flex flex-col gap-3' },
          h('div', { class: 'flex justify-end' }, toolbar),
          rows.length > 0
            ? h(
                'div',
                { class: 'overflow-hidden rounded-xl border border-border' },
                dataTable({
                  columns: PRODUCT_COLUMNS,
                  rows: visible(),
                  currency,
                  sort: sortKey,
                  dir: sortDir,
                  onSort: (key) => {
                    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
                    else {
                      sortKey = key
                      sortDir = PRODUCT_COLUMNS.find((c) => c.key === key)?.type === 'money' ? 'desc' : 'asc'
                    }
                    draw()
                  },
                  pageSize: 50,
                })
              )
            : emptyState('Nothing filed here yet', {
                description: 'Products land in this category from the Add Product form.',
                iconName: 'category',
              })
        )
      )
    }

    draw()
  }

  function openAdd(): void {
    const name = input({ autofocus: true, placeholder: mode === 'categories' ? 'Beverages' : 'Samsung' })
    const parent = select({
      options: categories.map((item) => ({ value: item.id, label: item.name })),
      placeholder: 'Top-level category',
    })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const submit = button(mode === 'categories' ? 'Add category' : 'Add brand', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({
      title: mode === 'categories' ? 'Add category' : 'Add brand',
      subtitle: mode === 'categories' ? 'Keep your product search easy to scan.' : 'Use the name customers recognize.',
      iconName: mode === 'categories' ? 'category' : 'sell',
      size: 'sm',
      footer: [h('div', { class: 'w-full' }, submit)],
    })

    async function save(): Promise<void> {
      const clean = name.value.trim()
      if (!clean) {
        errorSlot.textContent = `${mode === 'categories' ? 'A category' : 'A brand'} needs a name.`
        errorSlot.classList.remove('hidden')
        return
      }
      submit.disabled = true
      try {
        if (mode === 'categories') {
          const created = await repos.catalog.createCategory(clean, parent.value || null)
          categories = [...categories, created].sort((a, b) => a.name.localeCompare(b.name))
          toastSuccess(`Category “${created.name}” added`)
        } else {
          const created = await repos.catalog.createBrand(clean)
          brands = [...brands, created].sort((a, b) => a.name.localeCompare(b.name))
          toastSuccess(`Brand “${created.name}” added`)
        }
        dialog.close()
        renderList()
      } catch (error) {
        errorSlot.textContent = translateError(error).message
        errorSlot.classList.remove('hidden')
        submit.disabled = false
      }
    }

    submit.addEventListener('click', () => void save())
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void save()
      }
    })
    dialog.body.replaceChildren(
      h('div', { class: 'space-y-4' },
        field('Name', name, { required: true }),
        mode === 'categories' ? field('Parent', parent) : null,
        errorSlot
      )
    )
  }

  /**
   * The whole product list, page by page. The counts need every row, and a
   * shop's catalogue is hundreds of products, not millions — the same loop
   * the product export already trusts. Capped all the same, because a badge
   * is not worth an unbounded fetch on a bad day.
   */
  async function loadAllProducts(): Promise<ProductRow[]> {
    const all: ProductRow[] = []
    let cursor: string | null = null
    for (let page = 0; page < 50; page += 1) {
      const result = await repos.products.list({ limit: 200, ...(cursor ? { cursor } : {}) })
      all.push(...result.items)
      cursor = result.nextCursor
      if (!cursor) break
    }
    return all
  }

  async function load(): Promise<void> {
    loading = true
    renderList()
    try {
      ;[categories, brands, products] = await Promise.all([
        repos.catalog.listCategories(),
        repos.catalog.listBrands(),
        loadAllProducts(),
      ])
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      loading = false
      render()
    }
  }

  mount(
    root,
    h('div', { class: 'mb-4 flex flex-wrap items-end justify-between gap-3' },
      h('div', {},
        h('h1', { class: 'text-lg font-semibold text-content', text: 'Catalogue' }),
        h('p', { class: 'mt-1 text-sm text-content-muted', text: 'Manage the categories and brands used by your products.' })
      ),
      can('products.create') ? addButton : null
    ),
    h('div', { class: 'mb-3 flex flex-wrap items-center gap-2' },
      categoriesButton,
      brandsButton,
      h('div', { class: 'ml-auto w-full sm:w-64' }, searchInput)
    ),
    listSlot
  )
  void load()
  return root
}

export default catalogueView
