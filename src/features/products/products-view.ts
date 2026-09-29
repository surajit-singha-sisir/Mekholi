/**
 * Products (spec §8, §9, §45).
 *
 * ── Minimal data entry ───────────────────────────────────────────────────
 * The quick-add row takes three fields: name, price, stock. Everything else
 * has a sensible default, because the fastest way to make a shop stop using
 * software is to make adding a product feel like filling in a tax form.
 *
 * The full form is the same form with an "+ Advanced options" section that
 * stays collapsed. It is one component with a disclosure, not two screens —
 * two forms for one entity is how the two drift apart.
 *
 * ── Plugin fields ────────────────────────────────────────────────────────
 * The form renders whatever `registry.productFields` contains, so a plugin
 * adding an expiry date appears here with no edit to this file. Fields marked
 * `advanced` land in the collapsed section — unless the *shop type* promotes
 * them, which is the other half of the same idea: a pharmacy should meet the
 * expiry date on the way in, a bookstore should never meet it at all, and
 * neither of those is the plugin's decision to make (docs/08 §2, spec §8).
 *
 * Promotion is data: `data/shop_categories.json` names the keys, the session
 * carries the shop's type (migration 047), and `splitPluginFields` does the
 * rest. A field a shop type promotes is the same field a plugin registered —
 * nothing is duplicated and no plugin learns which shop it is in.
 */

import { h, icon } from '../../components/ui/h'
import { button, iconButton, spinner } from '../../components/ui/button'
import { input, select, checkbox, field, searchInput, textarea } from '../../components/ui/input'
import { badge, emptyState, panel } from '../../components/ui/card'
import { modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { confirm } from '../../components/feedback/modal'
import { getRepositories } from '../../app/data'
import { imageUploadsEnabled, uploadImage, validateImageFile } from '../../app/images'
import { imagePicker } from '../../components/ui/image-upload'
import { pluginFormSectionsHost } from '../../app/plugin-slots'
import { bindDrafts, clearDraft, restoreDraft } from '../../app/state/drafts'
import { translateError } from '../../app/platform/errors'
import { activeOrganization, can } from '../../app/state/session'
import { salesFloor } from '../../app/state/sales-floor'
import { activePromotedFields, activeShopType } from '../../app/shop-profile'
import { splitPluginFields } from '../../shared/types/shop-profile'
import { formatDate } from '../../shared/i18n'
import { downloadText } from '../../shared/export/download'
import {
  buildProductsCsv,
  buildProductsCsvTemplate,
  parseProductsCsv,
  type ProductCsvError,
  type ProductCsvRow,
} from './product-csv'
import type { PluginRegistry } from '../../shared/registry/plugin-registry'
import type { ProductField } from '../../shared/registry/plugin-types'
import type { Brand, Category, ProductRow, Tax, Unit } from '../../shared/types/records'
import { formatMoney, formatQty, milli, milliToNumber, minor, minorToNumber, parseMilli, parseMinor, type Milli, type Minor } from '../../shared/domain/money'

/**
 * Column visibility, named once.
 *
 * A phone shows the essentials — picture, name, price, stock, actions — and
 * every extra column appears as the screen earns it. Written as constants
 * because a header cell and its body cell must agree: they are two elements
 * in two functions, and a mismatch is a table that shifts by one column at
 * exactly one width.
 */
const UNTIL_SM = 'sm:hidden'
const AT_SM = 'hidden sm:table-cell'
const AT_LG = 'hidden lg:table-cell'
const AT_XL = 'hidden xl:table-cell'
const AT_2XL = 'hidden 2xl:table-cell'

export interface ProductsViewOptions {
  registry: PluginRegistry
  onOpenProduct?: (id: string) => void
}

export function productsView(options: ProductsViewOptions): HTMLElement {
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'

  let rows: ProductRow[] = []
  let cursor: string | null = null
  let searchTerm = ''
  let loading = false
  /** Stock on hand per product id, filled one page at a time. */
  let onHand: Record<string, Milli> = {}
  /**
   * Id → name for the columns a wide screen can afford. The product row
   * stores `category_id`, not "Rice", and a table of UUIDs helps nobody.
   * Fetched once per mount, not per page.
   */
  let categoryNames: Record<string, string> = {}
  let brandNames: Record<string, string> = {}
  let unitNames: Record<string, string> = {}

  const tableBody = h('tbody')
  const listBox = h('div', { class: '' })

  /**
   * The lookups behind Category, Brand and Unit.
   *
   * Deliberately best-effort: a role that may read products but not the
   * catalogue tables still gets the list, just with blank cells where the
   * names would be.
   */
  async function loadLookups(): Promise<void> {
    try {
      const [categories, brands, units] = await Promise.all([
        repos.catalog.listCategories(),
        repos.catalog.listBrands(),
        repos.catalog.listUnits(),
      ])
      categoryNames = Object.fromEntries(categories.map((item) => [item.id, item.name]))
      brandNames = Object.fromEntries(brands.map((item) => [item.id, item.name]))
      unitNames = Object.fromEntries(units.map((item) => [item.id, item.symbol || item.name]))
      if (rows.length > 0) render()
    } catch {
      /* names are a nicety; the list is the screen */
    }
  }

  async function load(reset: boolean): Promise<void> {
    if (loading) return
    loading = true
    if (reset) {
      cursor = null
      rows = []
    }
    try {
      const page = await repos.products.list({
        limit: 25,
        cursor,
        ...(searchTerm ? { search: searchTerm } : {}),
      })
      rows = reset ? page.items : [...rows, ...page.items]
      cursor = page.nextCursor
      if (reset) onHand = {}
      render()

      // Quantities are fetched after the list is on screen, not before it:
      // the names, prices and buttons are what the shop came for, and they
      // must not wait on a second round trip. The cell redraws when it lands.
      const tracked = page.items.filter((item) => item.track_stock).map((item) => item.id)
      if (tracked.length > 0) {
        try {
          const levels = await repos.products.onHand(tracked, salesFloor()?.warehouseId ?? null)
          // Every tracked product gets an entry, so "no balance row" reads as
          // a real zero instead of staying a dash forever.
          for (const id of tracked) onHand[id] = levels[id] ?? milli(0)
          render()
        } catch {
          // A stock table a role cannot read must not blank the product list.
        }
      }
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      loading = false
    }
  }

  function render(): void {
    if (rows.length === 0) {
      listBox.replaceChildren(
        emptyState(searchTerm ? 'No products match that search' : 'No products yet', {
          description: searchTerm
            ? 'Try a different name, SKU or barcode.'
            : 'Add your first product — a name and a price is enough to start selling.',
          iconName: 'inventory_2',
          action: button('Add product', { variant: 'primary', icon: 'add', onClick: () => openForm(null) }),
        })
      )
      return
    }

    listBox.replaceChildren(
      panel(
        // Eleven columns do not fit a phone even after the responsive ones
        // have dropped out. The table keeps its width and the box scrolls.
        h('div', { class: 'w-full min-w-0 overflow-x-auto' },
        // `w-max min-w-full`: the columns are as wide as their contents and no
        // wider. The old `min-w-[42rem]` was a guess at how much room eleven
        // columns need — it forced a sideways scrollbar onto a shop with short
        // product names, and still was not enough for one with long ones.
        h('table', { class: 'w-max min-w-full table-auto text-sm' },
          h('thead', { class: 'text-left text-xs text-content-muted border-b border-border' },
            h('tr', {},
              h('th', { class: 'px-3 py-2 font-medium', text: 'Product' }),
              h('th', { class: `px-3 py-2 font-medium ${AT_SM}`, text: 'SKU' }),
              h('th', { class: `px-3 py-2 font-medium ${AT_LG}`, text: 'Category' }),
              h('th', { class: `px-3 py-2 font-medium ${AT_XL}`, text: 'Brand' }),
              h('th', { class: 'px-3 py-2 font-medium text-right', text: 'Price' }),
              h('th', { class: `px-3 py-2 font-medium text-right ${AT_LG}`, text: 'Cost' }),
              h('th', { class: `px-3 py-2 font-medium text-right ${AT_XL}`, text: 'Margin' }),
              h('th', { class: 'px-3 py-2 font-medium text-center', text: 'Stock' }),
              h('th', { class: `px-3 py-2 font-medium ${AT_LG}`, text: 'Status' }),
              h('th', { class: `px-3 py-2 font-medium ${AT_2XL}`, text: 'Added' }),
              h('th', { class: 'px-3 py-2' })
            )
          ),
          tableBody
        )
        )
      )
    )

    tableBody.replaceChildren(...rows.map(productRow))

    if (cursor) {
      listBox.append(
        h('div', { class: 'p-3 text-center' },
          button('Load more', { variant: 'outline', onClick: () => void load(false) })
        )
      )
    }
  }

  function productRow(product: ProductRow): HTMLElement {
    const price = minor(Math.round(Number(product.selling_price) * 100) as Minor)
    const cost = minor(Math.round(Number(product.cost_price) * 100) as Minor)
    const unit = product.unit_id ? unitNames[product.unit_id] : undefined
    return h('tr', { class: 'border-b border-border hover:bg-surface-muted' },
      h('td', { class: 'px-3 py-2' },
        h('div', { class: 'flex items-center gap-3' },
          productThumb(product),
          h('div', { class: 'min-w-0' },
            h('button', {
              type: 'button',
              // No character cap: the column is as wide as the longest name
              // and the box scrolls if that is wider than the phone. A name
              // clipped at 22 characters is two products that look identical.
              class: 'block text-left font-medium text-content hover:underline',
              text: product.name,
              title: product.name,
              onClick: () => openForm(product.id),
            }),
            // Narrow screens drop the SKU column, so it rides under the name
            // rather than disappearing: it is what a shopkeeper reads out on
            // the phone to a supplier.
            h('span', {
              class: `block font-mono text-[11px] text-content-subtle ${UNTIL_SM}`,
              text: product.sku ?? '',
            })
          )
        )
      ),
      h('td', { class: `px-3 py-2 font-mono text-xs text-content-muted ${AT_SM}`, text: product.sku ?? '—' }),
      h('td', { class: `px-3 py-2 text-content-muted ${AT_LG}`, text: (product.category_id && categoryNames[product.category_id]) || '—' }),
      h('td', { class: `px-3 py-2 text-content-muted ${AT_XL}`, text: (product.brand_id && brandNames[product.brand_id]) || '—' }),
      h('td', { class: 'px-3 py-2 text-right tabular-nums text-content' },
        h('span', { class: 'font-medium', text: formatMoney(price, { currency }) }),
        // Per-unit pricing is the difference between ৳450 and ৳450 a kilo.
        unit ? h('span', { class: 'text-xs text-content-subtle', text: ` /${unit}` }) : null,
        product.tax_inclusive ? h('span', { class: `block text-[11px] text-content-subtle ${AT_LG}`, text: 'tax incl.' }) : null
      ),
      h('td', { class: `px-3 py-2 text-right tabular-nums text-content-muted ${AT_LG}`, text: formatMoney(cost, { currency, symbol: false }) }),
      h('td', { class: `px-3 py-2 text-right tabular-nums ${AT_XL}` }, marginCell(price, cost)),
      h('td', { class: 'px-3 py-2 text-center' }, stockCell(product)),
      h('td', { class: `px-3 py-2 ${AT_LG}` },
        product.is_active
          ? badge('Active', { tone: 'success' })
          : badge('Inactive', { tone: 'neutral' })
      ),
      h('td', { class: `px-3 py-2 whitespace-nowrap text-xs text-content-subtle ${AT_2XL}`, text: formatDate(product.created_at, { dateStyle: 'medium' }) }),
      h('td', { class: 'px-3 py-2' },
        h('div', { class: 'flex justify-end gap-1' },
          iconButton('edit', `Edit ${product.name}`, {
            size: 'sm',
            variant: 'ghost',
            onClick: () => void openForm(product.id),
          }),
          iconButton('content_copy', `Copy ${product.name}`, {
            size: 'sm',
            variant: 'ghost',
            onClick: () => void duplicate(product),
          }),
          iconButton('delete', `Delete ${product.name}`, {
            size: 'sm',
            variant: 'ghost',
            class: 'text-danger hover:bg-danger-soft',
            onClick: () => void remove(product),
          })
        )
      )
    )
  }

  /**
   * Margin, as a percentage of the selling price.
   *
   * The table already carried price and cost and left the subtraction to the
   * owner. This is the number they were doing in their head, tinted so a
   * line that loses money is visible while scrolling — which is the only
   * reason it is worth a column rather than a report.
   */
  function marginCell(price: Minor, cost: Minor): HTMLElement {
    if (price <= 0 || cost <= 0) return h('span', { class: 'text-content-subtle', text: '—' })
    const percent = ((price - cost) / price) * 100
    const tone = percent < 0 ? 'text-danger' : percent < 10 ? 'text-warning' : 'text-content-muted'
    return h('span', { class: tone, text: `${percent.toFixed(percent < 10 ? 1 : 0)}%` })
  }

  /**
   * The photo, at the head of the row — and the fastest way to add one.
   *
   * The thumbnail shipped read-only and every row showed the placeholder,
   * because nothing in the shop had a photo: products get added through
   * Quick add, which never asked for one, and nobody opens a full form again
   * just to attach a picture. A column of identical grey boxes is not a
   * feature. So the box is a button: pick a file, it uploads and the row
   * redraws. One tap, from the screen you are already on.
   *
   * Three details earn their keep. The box is a fixed `h-10 w-10` square so
   * every row is the same height whatever shape the file is, and the image
   * is `object-cover` so a wide label crops rather than letterboxes.
   * `loading="lazy"` keeps a 200-row catalogue from fetching 200 images on a
   * shop's phone connection. And an `error` handler swaps a dead ImgBB link
   * for the placeholder: a broken-image glyph in every row is worse than no
   * picture, and links do rot.
   */
  function productThumb(product: ProductRow): HTMLElement {
    const box = 'h-10 w-10 shrink-0 aspect-square rounded-md border border-border object-cover bg-surface-muted'

    const placeholder = (): HTMLElement =>
      h('div', { class: `${box} grid place-items-center text-content-subtle`, 'aria-hidden': 'true' },
        icon(product.image_url ? 'broken_image' : 'add_photo_alternate', 'text-lg'))

    const face = (): HTMLElement => {
      if (!product.image_url) return placeholder()
      const img = h('img', {
        src: product.image_url,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        class: box,
      }) as HTMLImageElement
      img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true })
      return img
    }

    // No uploader configured: the picture is still shown, it just cannot be
    // changed from here.
    if (!imageUploadsEnabled() || !can('products.edit')) return face()

    const file = h('input', { type: 'file', accept: 'image/*', class: 'sr-only' }) as HTMLInputElement
    const slot = h('span', { class: 'relative block' }, face())
    const trigger = h('button', {
      type: 'button',
      class:
        'group relative block rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'aria-label': `${product.image_url ? 'Change' : 'Add'} photo for ${product.name}`,
      title: `${product.image_url ? 'Change' : 'Add'} photo`,
      onClick: () => file.click(),
    }, slot,
      // A hint that only appears on hover, so the list stays quiet.
      h('span', {
        class:
          'pointer-events-none absolute inset-0 hidden place-items-center rounded-md bg-content/55 ' +
          'text-surface group-hover:grid',
        'aria-hidden': 'true',
      }, icon('photo_camera', 'text-base'))
    )

    file.addEventListener('change', () => {
      const chosen = file.files?.[0]
      file.value = ''
      if (chosen) void attachPhoto(product, chosen, slot)
    })

    return h('span', { class: 'inline-flex' }, trigger, file)
  }

  /**
   * Upload, then store the link. The row shows a spinner in the square
   * meanwhile, because on a shop connection this takes seconds and a button
   * that looks inert gets pressed again.
   */
  async function attachPhoto(product: ProductRow, file: File, slot: HTMLElement): Promise<void> {
    const problem = validateImageFile(file)
    if (problem) {
      toastError(problem)
      return
    }
    const busy = h('span', { class: 'grid h-10 w-10 place-items-center rounded-md border border-border bg-surface-muted' }, spinner('h-4 w-4'))
    slot.replaceChildren(busy)
    try {
      const uploaded = await uploadImage(file, { name: product.name })
      await repos.products.update(product.id, { image_url: uploaded.url })
      // Patch the row in place rather than refetching the page: a reload
      // would lose the scroll position in a long catalogue.
      rows = rows.map((row) => (row.id === product.id ? { ...row, image_url: uploaded.url } : row))
      toastSuccess(`Photo added to “${product.name}”`)
      render()
    } catch (error) {
      toastError(translateError(error).message)
      render()
    }
  }

  /**
   * The Stock column used to read "Tracked" — a fact about configuration
   * where a shopkeeper is looking for a number. Quantities arrive one query
   * per page; until they do, the cell shows a dash rather than a zero,
   * because "0" and "not loaded yet" are very different answers.
   */
  function stockCell(product: ProductRow): HTMLElement {
    if (!product.track_stock) return badge('Not tracked', { tone: 'info' })
    const qty = onHand[product.id]
    if (qty === undefined) return h('span', { class: 'text-content-subtle', text: '—' })
    const reorder = parseMilli(product.reorder_point || '0', { decimal: true }) ?? milli(0)
    const tone = qty <= 0 ? 'danger' : reorder > 0 && qty <= reorder ? 'warning' : 'neutral'
    return badge(formatQty(qty, { decimal: true }), { tone })
  }

  async function duplicate(product: ProductRow): Promise<void> {
    // A copy is cheap to make and easy to make twice: two taps on a slow
    // connection used to leave two identical "(copy)" rows behind.
    const ok = await confirm(`Copy “${product.name}”?`, {
      message:
        'A new product is created with the same prices and settings, named ' +
        `“${product.name} (copy)”. It starts with no SKU, no barcodes and no stock.`,
      confirmLabel: 'Make a copy',
      iconName: 'content_copy',
    })
    if (!ok) return
    try {
      const copy = await repos.products.duplicate(product.id)
      toastSuccess(`Copied as “${copy.name}”`)
      await load(true)
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  /**
   * Delete means delete.
   *
   * There is no trash in Mekholi, so the old "Archive" button left rows the
   * owner could neither see nor remove. This asks plainly, in the words that
   * describe what happens — permanent, database, cannot be undone — and then
   * does it. The one case it cannot honour is a product with sales behind it;
   * the database refuses that, and the refusal is offered back as the archive
   * that was the right answer all along.
   */
  async function remove(product: ProductRow): Promise<void> {
    const ok = await confirm(`Delete “${product.name}”?`, {
      message:
        'This permanently removes the product, its variants, barcodes and ' +
        'stock records from the database. It cannot be undone.',
      confirmLabel: 'Delete permanently',
      tone: 'danger',
      iconName: 'delete_forever',
    })
    if (!ok) return
    try {
      await repos.products.remove(product.id)
      toastSuccess(`“${product.name}” deleted`)
      await load(true)
    } catch (error) {
      const message = translateError(error).message
      // 23001 / restrict_violation: the product is on the books.
      const onTheBooks = /sale line|purchase line|return line|restrict|violat|referenc/i.test(message)
      if (!onTheBooks) {
        toastError(message)
        return
      }
      const archiveInstead = await confirm(`“${product.name}” cannot be deleted`, {
        message: `${message} Archiving hides it from the POS and every list, and keeps those records readable.`,
        confirmLabel: 'Archive instead',
        tone: 'danger',
        iconName: 'archive',
      })
      if (!archiveInstead) return
      try {
        await repos.products.archive(product.id)
        toastSuccess('Archived')
        await load(true)
      } catch (archiveError) {
        toastError(translateError(archiveError).message)
      }
    }
  }

  async function openForm(id: string | null): Promise<void> {
    let product: ProductRow | null = null
    if (id) {
      product = await repos.products.get(id)
      if (!product) {
        toastError('That product no longer exists.')
        return
      }
    }
    openProductForm({
      product,
      registry: options.registry,
      onSaved: () => void load(true),
    })
  }

  const root = h('div', { class: 'flex w-full min-w-0 flex-col p-4' },
    h('div', { class: 'mb-3 flex flex-wrap items-center gap-2' },
      h('div', { class: 'flex-1 max-w-sm' },
        searchInput('Search by name, SKU or barcode', (value) => {
          searchTerm = value
          void load(true)
        })
      ),
      h('div', { class: 'flex-1' }),
      ...(can('products.edit')
        ? [button('Import', { variant: 'outline', icon: 'upload', onClick: () => openImport() })]
        : []),
      button('Export', { variant: 'outline', icon: 'download', onClick: () => void exportCsv() }),
      button('Quick add', { variant: 'outline', icon: 'bolt', onClick: () => openQuickAdd() }),
      button('Add product', { variant: 'primary', icon: 'add', onClick: () => void openForm(null) })
    ),
    listBox
  )

  void load(true)
  void loadLookups()
  return root

  function openQuickAdd(): void {
    const nameInput = input({ placeholder: 'e.g. Miniket Rice 5kg', autofocus: true })
    const priceInput = input({ type: 'text', inputmode: 'decimal', placeholder: '0.00' })
    const stockInput = input({ type: 'text', inputmode: 'decimal', placeholder: '0' })
    // A photo taken here is why the list has pictures at all: this is the
    // dialog a shop actually uses, and it never asked for one. Optional, and
    // the bytes only leave the phone when Save is pressed.
    const photo = imagePicker({
      label: 'Product photo',
      previewClass: 'h-14 w-14',
      validate: (file) => validateImageFile(file),
      ...(imageUploadsEnabled()
        ? {
            upload: async (file, onProgress) => {
              const uploaded = await uploadImage(file, {
                name: nameInput.value.trim() || file.name,
                onProgress,
              })
              return { url: uploaded.url, thumbUrl: uploaded.thumbUrl }
            },
          }
        : { disabledHint: 'Add an ImgBB key in Settings → Image uploads to add photos.' }),
    })
    const errorSlot = h('p', { class: 'text-sm text-danger mt-2 hidden' })

    const dialog = modal({
      title: 'Quick add product',
      subtitle: 'A name and a price is enough. A photo helps at the counter.',
      iconName: 'bolt',
      size: 'sm',
      footer: [
        button('Cancel', { variant: 'ghost', onClick: () => dialog.close() }),
        button('Save', {
          variant: 'primary',
          icon: 'check',
          onClick: () => void save(),
        }),
      ],
    })

    async function save(): Promise<void> {
      errorSlot.classList.add('hidden')
      const name = nameInput.value.trim()
      const price = parseMinor(priceInput.value)
      const openingStock = parseMilli(stockInput.value, { decimal: true })
      if (!name) {
        errorSlot.textContent = 'A product needs a name.'
        errorSlot.classList.remove('hidden')
        return
      }
      if (price === null || price < 0) {
        errorSlot.textContent = 'Enter a valid selling price.'
        errorSlot.classList.remove('hidden')
        return
      }
      if (stockInput.value.trim() && (openingStock === null || openingStock < 0)) {
        errorSlot.textContent = 'Enter a valid opening stock quantity.'
        errorSlot.classList.remove('hidden')
        return
      }
      try {
        const imageUrl = await photo.commit()
        const created = await repos.products.create({
          name,
          image_url: imageUrl,
          selling_price: minorToNumber(price),
          cost_price: 0,
          tax_inclusive: false,
          reorder_point: 0,
          track_stock: true,
          allow_negative: false,
          is_active: true,
          metadata: {},
        })
        if (openingStock && openingStock > 0) {
          const detail = await repos.products.getWithVariants(created.id)
          const variant = detail?.variants.find((entry) => entry.is_default) ?? detail?.variants[0]
          const warehouseId = salesFloor()?.warehouseId ?? (await repos.stock.listWarehouses())[0]?.id
          if (!variant || !warehouseId) throw new Error('The product was created, but no stock location is available.')
          await repos.stock.stockIn(warehouseId, [{ variantId: variant.id, qty: openingStock }], {
            note: 'Opening stock',
          })
        }
        clearDraft('products.quickAdd')
        dialog.close()
        toastSuccess(created.sku ? `“${name}” added · SKU ${created.sku}` : `“${name}” added`)
        await load(true)
      } catch (error) {
        errorSlot.textContent = translateError(error).message
        errorSlot.classList.remove('hidden')
      }
    }

    dialog.body.replaceChildren(
      h('div', { class: 'space-y-3' },
        field('Name', nameInput, { required: true }),
        h('div', { class: 'grid grid-cols-2 gap-3' },
          field('Selling price', priceInput, { required: true }),
          field('Opening stock', stockInput, { hint: 'Saved as a stock-in at zero cost' }),
          field('Photo', photo.root, { hint: 'Optional — it shows in the list and on the POS tile' })
        ),
        errorSlot
      )
    )

    // Survives a failed save or an accidental close; cleared only once the
    // product actually exists.
    bindDrafts(dialog.body, 'products.quickAdd')

    for (const el of [nameInput, priceInput, stockInput]) {
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void save()
        }
      })
    }
  }

  // ── CSV import / export (spec §9 method 4) ──────────────────────────────

  /** Every product, not the visible page — an export of 25 of 400 is a trap. */
  async function fetchAllProducts(): Promise<ProductRow[]> {
    const all: ProductRow[] = []
    let pageCursor: string | null = null
    do {
      const page = await repos.products.list({ limit: 200, cursor: pageCursor })
      all.push(...page.items)
      pageCursor = page.nextCursor
    } while (pageCursor && all.length < 10000)
    return all
  }

  async function exportCsv(): Promise<void> {
    try {
      // The lookups turn `category_id` into "Grocery" in the file. They are
      // fetched at mount, but an export clicked immediately must not race
      // that fetch and write UUID-less blanks.
      await loadLookups()
      const all = await fetchAllProducts()
      if (all.length === 0) {
        toastError('There are no products to export yet.')
        return
      }
      const csv = buildProductsCsv(all, {
        categories: categoryNames,
        brands: brandNames,
        units: unitNames,
      })
      const day = new Date().toISOString().slice(0, 10)
      const saved = downloadText(`products-${day}.csv`, csv, 'text/csv')
      if (saved.ok) toastSuccess(`Exported ${all.length} product${all.length === 1 ? '' : 's'}`)
      else toastError(saved.reason ?? 'The file could not be saved.')
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  /**
   * Import: explain → choose file → preview what will happen → do it.
   *
   * The preview step is the point. A shopkeeper about to create four hundred
   * products deserves to see "400 ready, 3 rows skipped and why" *before*
   * anything is written — an import that starts on file-pick cannot be
   * backed out of politely.
   */
  function openImport(): void {
    const dialog = modal({
      title: 'Import products from CSV',
      subtitle: 'One row per product. Only Name and Selling price are required.',
      iconName: 'upload',
      size: 'lg',
    })

    const file = h('input', { type: 'file', accept: '.csv,text/csv', class: 'sr-only' }) as HTMLInputElement
    file.addEventListener('change', () => {
      const chosen = file.files?.[0]
      file.value = ''
      if (chosen) void preview(chosen)
    })

    const intro = (): HTMLElement[] => [
      h('div', { class: 'space-y-3 text-sm text-content-muted' },
        h('p', {
          text:
            'Categories and brands named in the file are created if they do not exist. ' +
            'Units are matched by name or symbol; a unit the shop does not have is left blank rather than invented.',
        }),
        h('p', {
          text:
            'Broken rows are skipped and reported with their line numbers — one typo never costs the whole file.',
        })
      ),
      h('div', { class: 'mt-4 flex items-center justify-end gap-2' },
        button('Download template', {
          variant: 'outline',
          icon: 'download',
          onClick: () => {
            const saved = downloadText('products-template.csv', buildProductsCsvTemplate(), 'text/csv')
            if (!saved.ok) toastError(saved.reason ?? 'The file could not be saved.')
          },
        }),
        button('Choose file', { variant: 'primary', icon: 'folder_open', onClick: () => file.click() })
      ),
      file,
    ]

    dialog.body.replaceChildren(...intro())

    async function preview(chosen: File): Promise<void> {
      let parsed: { rows: ProductCsvRow[]; errors: ProductCsvError[] }
      try {
        parsed = parseProductsCsv(await chosen.text())
      } catch {
        toastError('That file could not be read.')
        return
      }
      const { rows: toImport, errors } = parsed

      const errorList =
        errors.length > 0
          ? h('div', { class: 'rounded-md border border-border bg-surface-muted p-3 text-sm' },
              h('p', { class: 'font-medium text-content mb-1', text: `${errors.length} row${errors.length === 1 ? '' : 's'} will be skipped:` }),
              ...errors.slice(0, 8).map((problem) =>
                h('p', { class: 'text-content-muted', text: `Line ${problem.line}: ${problem.message}` })
              ),
              ...(errors.length > 8
                ? [h('p', { class: 'text-content-subtle', text: `…and ${errors.length - 8} more.` })]
                : [])
            )
          : null

      const status = h('p', { class: 'text-sm text-content-muted' })

      const importButton = button(`Import ${toImport.length} product${toImport.length === 1 ? '' : 's'}`, {
        variant: 'primary',
        icon: 'check',
        onClick: () => void run(),
      })
      if (toImport.length === 0) importButton.setAttribute('disabled', 'true')

      dialog.body.replaceChildren(
        h('div', { class: 'space-y-3' },
          h('p', { class: 'text-sm text-content', text: `“${chosen.name}” — ${toImport.length} product${toImport.length === 1 ? '' : 's'} ready to import.` }),
          ...(errorList ? [errorList] : []),
          status,
          h('div', { class: 'flex items-center justify-end gap-2' },
            button('Cancel', { variant: 'ghost', onClick: () => dialog.close() }),
            importButton
          )
        ),
        file
      )

      async function run(): Promise<void> {
        importButton.setAttribute('disabled', 'true')

        // Name → id caches, so "Grocery" is looked up (or created) once for
        // the whole file, not once per row.
        const categoryIds = new Map(Object.entries(categoryNames).map(([id, name]) => [name.toLowerCase(), id]))
        const brandIds = new Map(Object.entries(brandNames).map(([id, name]) => [name.toLowerCase(), id]))
        const unitIds = new Map<string, string>()
        try {
          const units = await repos.catalog.listUnits()
          for (const unit of units) {
            unitIds.set(unit.name.toLowerCase(), unit.id)
            if (unit.symbol) unitIds.set(unit.symbol.toLowerCase(), unit.id)
          }
        } catch {
          /* units stay unmatched; the products still import */
        }

        const resolveCategory = async (name: string): Promise<string | null> => {
          const hit = categoryIds.get(name.toLowerCase())
          if (hit) return hit
          try {
            const created = await repos.catalog.createCategory(name)
            categoryIds.set(name.toLowerCase(), created.id)
            categoryNames[created.id] = created.name
            return created.id
          } catch {
            return null
          }
        }
        const resolveBrand = async (name: string): Promise<string | null> => {
          const hit = brandIds.get(name.toLowerCase())
          if (hit) return hit
          try {
            const created = await repos.catalog.createBrand(name)
            brandIds.set(name.toLowerCase(), created.id)
            brandNames[created.id] = created.name
            return created.id
          } catch {
            return null
          }
        }

        let done = 0
        const failed: ProductCsvError[] = []
        for (const row of toImport) {
          status.textContent = `Importing ${done + 1} of ${toImport.length}…`
          try {
            await repos.products.create({
              name: row.name,
              sku: row.sku,
              description: row.description,
              category_id: row.category ? await resolveCategory(row.category) : null,
              brand_id: row.brand ? await resolveBrand(row.brand) : null,
              unit_id: row.unit ? (unitIds.get(row.unit.toLowerCase()) ?? null) : null,
              selling_price: row.selling_price,
              cost_price: row.cost_price,
              tax_inclusive: row.tax_inclusive,
              reorder_point: row.reorder_point,
              track_stock: row.track_stock,
              allow_negative: row.allow_negative,
              is_active: row.is_active,
              image_url: row.image_url,
              metadata: {},
            })
            done += 1
          } catch (error) {
            failed.push({ line: row.line, message: `"${row.name}": ${translateError(error).message}` })
          }
        }

        if (failed.length === 0) {
          dialog.close()
          toastSuccess(`Imported ${done} product${done === 1 ? '' : 's'}`)
        } else {
          // Partial success is reported as exactly that — the dialog stays,
          // names names, and the shop decides what to do about the rest.
          status.textContent = ''
          dialog.body.replaceChildren(
            h('div', { class: 'space-y-3' },
              h('p', { class: 'text-sm text-content', text: `Imported ${done} of ${toImport.length}. ${failed.length} failed:` }),
              h('div', { class: 'rounded-md border border-border bg-surface-muted p-3 text-sm' },
                ...failed.slice(0, 8).map((problem) =>
                  h('p', { class: 'text-content-muted', text: `Line ${problem.line}: ${problem.message}` })
                ),
                ...(failed.length > 8
                  ? [h('p', { class: 'text-content-subtle', text: `…and ${failed.length - 8} more.` })]
                  : [])
              ),
              h('div', { class: 'flex items-center justify-end gap-2' },
                button('Close', { variant: 'primary', onClick: () => dialog.close() })
              )
            )
          )
        }
        await load(true)
      }
    }
  }
}

// ── Product form helpers ──────────────────────────────────────────────────

interface ComboItem {
  id: string
  name: string
}

interface ProductComboboxOptions {
  placeholder: string
  onCreate: (name: string) => Promise<ComboItem>
}

interface ProductCombobox {
  root: HTMLElement
  setItems(items: readonly ComboItem[]): void
  setValue(id: string | null): void
  value(): string | null
}

/** A searchable catalogue selector that can create a missing item inline. */
function productCombobox(options: ProductComboboxOptions): ProductCombobox {
  let items: ComboItem[] = []
  let selectedId: string | null = null
  let creating = false
  const search = input({
    type: 'search',
    placeholder: options.placeholder,
    autocomplete: 'off',
  })
  const list = h('div', {
    class: 'absolute z-20 mt-1 hidden max-h-56 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg',
  })

  function close(): void {
    list.classList.add('hidden')
  }

  function draw(): void {
    const needle = search.value.trim().toLowerCase()
    const matches = items.filter((item) => item.name.toLowerCase().includes(needle)).slice(0, 30)
    const exact = items.some((item) => item.name.toLowerCase() === needle)
    const actions: HTMLElement[] = matches.map((item) =>
      h('button', {
        type: 'button',
        class: 'block min-h-11 w-full border-b border-border px-3 py-2 text-left text-sm text-content hover:bg-surface-muted',
        text: item.name,
        onclick: () => {
          selectedId = item.id
          search.value = item.name
          close()
        },
      })
    )
    if (needle && !exact) {
      actions.push(
        h('button', {
          type: 'button',
          class: 'block min-h-11 w-full px-3 py-2 text-left text-sm font-medium text-primary hover:bg-surface-muted disabled:opacity-60',
          text: creating ? 'Adding…' : `+ Add “${search.value.trim()}”`,
          disabled: creating,
          onclick: () => void createCurrent(),
        })
      )
    }
    list.replaceChildren(
      ...(actions.length > 0
        ? actions
        : [h('p', { class: 'px-3 py-3 text-sm text-content-muted', text: 'No matches.' })])
    )
    list.classList.remove('hidden')
  }

  async function createCurrent(): Promise<void> {
    const name = search.value.trim()
    if (!name || creating) return
    creating = true
    draw()
    try {
      const created = await options.onCreate(name)
      items = [...items, created].sort((a, b) => a.name.localeCompare(b.name))
      selectedId = created.id
      search.value = created.name
      close()
    } finally {
      creating = false
    }
  }

  search.addEventListener('input', draw)
  search.addEventListener('focus', draw)
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
    if (event.key === 'Enter' && search.value.trim() && !list.classList.contains('hidden')) {
      event.preventDefault()
      const first = list.querySelector('button')
      if (first) (first as HTMLButtonElement).click()
    }
  })

  const root = h('div', { class: 'relative' }, search, list)
  return {
    root,
    setItems(next) {
      items = [...next].sort((a, b) => a.name.localeCompare(b.name))
    },
    setValue(id) {
      selectedId = id
      search.value = items.find((item) => item.id === id)?.name ?? ''
    },
    value: () => selectedId,
  }
}

function barcodeValues(value: string): string[] {
  return [...new Set(value.split(/[\\n,]+/).map((code) => code.trim()).filter(Boolean))]
}

// ── Full form ─────────────────────────────────────────────────────────────

interface FormOptions {
  product: ProductRow | null
  registry: PluginRegistry
  onSaved: () => void
}

function openProductForm(options: FormOptions): void {
  const { product, registry, onSaved } = options
  const repos = getRepositories()
  const currency = activeOrganization()?.currency ?? 'BDT'
  const draftKey = `products.form.${product?.id ?? 'new'}`

  let categories: Category[] = []
  let brands: Brand[] = []
  let units: Unit[] = []
  let taxes: Tax[] = []

  const nameInput = input({ value: product?.name ?? '', autofocus: true })
  const skuInput = input({ value: product?.sku ?? '', placeholder: 'Leave blank for MIN-0007' })
  const priceInput = input({
    type: 'text',
    inputmode: 'decimal',
    value: product?.selling_price ?? '',
  })
  const costInput = input({
    type: 'text',
    inputmode: 'decimal',
    value: product?.cost_price ?? '',
  })
  const descriptionInput = textarea({ value: product?.description ?? '', rows: 2 })
  const taxInclusiveBox = checkbox({ label: 'Price includes tax', checked: product?.tax_inclusive ?? false })
  const trackStockBox = checkbox({ label: 'Track stock', checked: product?.track_stock ?? true })
  const allowNegativeBox = checkbox({ label: 'Allow selling below zero', checked: product?.allow_negative ?? false })
  const activeBox = checkbox({ label: 'Active (sellable)', checked: product?.is_active ?? true })
  const reorderInput = input({ type: 'text', inputmode: 'decimal', value: product?.reorder_point ?? '0' })

  const categoryCombo = productCombobox({
    placeholder: 'Search or add a category…',
    onCreate: async (name) => repos.catalog.createCategory(name),
  })
  const brandCombo = productCombobox({
    placeholder: 'Search or add a brand…',
    onCreate: async (name) => repos.catalog.createBrand(name),
  })
  const unitSelect = select({ options: [], placeholder: 'Each' })
  const taxSelect = select({ options: [], placeholder: 'No tax' })
  const barcodeInput = textarea({
    value: '',
    rows: 2,
    placeholder: 'One barcode per line or separated by commas',
  })
  // Stock lives on this form, for both halves of the job: a new product opens
  // with a count, and an existing one can be corrected here. Sending an owner
  // to /stock to fix a number they are already looking at is a route, a
  // search and a second dialog for one edit.
  const stockInput = input({ type: 'text', inputmode: 'decimal', placeholder: '0' })
  /** On hand when the form opened; the delta on save is what gets recorded. */
  let stockBefore: Milli = milli(0)
  let stockKnown = false

  // One picker, one uploader. The bytes only leave the device when `commit()`
  // runs during save, so a form abandoned half-filled costs a shop nothing in
  // data — which on a shared phone connection is the difference between a
  // feature used and a feature avoided (docs/09).
  const imageField = imagePicker({
    value: product?.image_url ?? null,
    label: product?.name ?? 'Product image',
    validate: (file) => validateImageFile(file),
    ...(imageUploadsEnabled()
      ? {
          upload: async (file, onProgress) => {
            const uploaded = await uploadImage(file, {
              name: nameInput.value.trim() || file.name,
              onProgress,
            })
            return { url: uploaded.url, thumbUrl: uploaded.thumbUrl }
          },
        }
      : { disabledHint: 'Add an ImgBB key in Settings → Image uploads to enable photos.' }),
  })

  const errorSlot = h('p', { class: 'text-sm text-danger mt-2 hidden' })
  const saveButton = button(product ? 'Save changes' : 'Create product', {
    variant: 'primary',
    icon: 'check',
    onClick: () => void save(),
  })

  const dialog = modal({
    title: product ? 'Edit product' : 'New product',
    subtitle: 'Only the name is required.',
    iconName: 'inventory_2',
    size: 'lg',
    footer: [
      button('Cancel', { variant: 'ghost', onClick: () => dialog.close() }),
      saveButton,
    ],
  })

  // Plugin-registered fields, split by the section the plugin asked for — and
  // by what this shop type promotes out of it. A promoted field is drawn in the
  // basic section, once, and the fields a shop type does not name keep exactly
  // the section their plugin chose.
  const pluginFields = registry.productFields.items
  const { basic: basicPluginFields, advanced: advancedPluginFields } = splitPluginFields(
    pluginFields,
    activePromotedFields()
  )
  const pluginInputs = new Map<string, HTMLElement & { value?: string }>()

  function renderPluginField(definition: ProductField): HTMLElement {
    const metadata = (product?.metadata ?? {}) as Record<string, unknown>
    const current = metadata[definition.key]
    const value = typeof current === 'string' || typeof current === 'number' ? String(current) : ''

    let control: HTMLElement
    switch (definition.type) {
      case 'select':
        control = select({
          options: definition.options ?? [],
          value,
          placeholder: definition.placeholder ?? 'Choose…',
        })
        break
      case 'boolean': {
        let checked = current === true
        control = checkbox({
          label: definition.placeholder ?? '',
          checked,
          onChange: (next) => {
            checked = next
          },
        })
        ;(control as HTMLElement & { readBoolean: () => boolean }).readBoolean = () => checked
        break
      }
      case 'textarea':
        control = textarea({ value, placeholder: definition.placeholder })
        break
      case 'number':
      case 'money':
        control = input({ type: 'text', inputmode: 'decimal', value, placeholder: definition.placeholder })
        break
      case 'date':
        control = input({ type: 'date', value })
        break
      case 'datetime':
        control = input({ type: 'datetime-local', value })
        break
      default:
        control = input({ value, placeholder: definition.placeholder })
    }

    pluginInputs.set(definition.key, control as HTMLElement & { value?: string })
    return field(definition.label, control, { required: definition.required === true })
  }

  // Advanced section, collapsed until asked for (spec §8).
  const advancedBody = h('div', { class: 'hidden grid grid-cols-2 gap-3 pt-3' })
  const advancedToggle = button('Advanced options', {
    variant: 'ghost',
    size: 'sm',
    trailingIcon: 'expand_more',
    onClick: () => {
      const open = advancedBody.classList.toggle('hidden') === false
      advancedToggle.querySelector('.material-symbols-rounded')!.textContent = open
        ? 'expand_less'
        : 'expand_more'
    },
  })

  async function save(): Promise<void> {
    errorSlot.classList.add('hidden')
    const name = nameInput.value.trim()
    const sellingPrice = parseMinor(priceInput.value)
    const costPrice = parseMinor(costInput.value || '0')
    const reorderPoint = parseMilli(reorderInput.value || '0', { decimal: true })
    const stockWanted = parseMilli(stockInput.value || '0', { decimal: true })
    const trackStock = trackStockBox.querySelector('input')?.checked ?? true
    if (!name) {
      errorSlot.textContent = 'A product needs a name.'
      errorSlot.classList.remove('hidden')
      return
    }
    if (sellingPrice === null || sellingPrice < 0) {
      errorSlot.textContent = 'Enter a valid selling price.'
      errorSlot.classList.remove('hidden')
      return
    }
    if (costPrice === null || reorderPoint === null || stockWanted === null || stockWanted < 0) {
      errorSlot.textContent = 'Check the cost, reorder point and stock quantities.'
      errorSlot.classList.remove('hidden')
      return
    }

    // Plugin validators run before anything is sent, so a plugin can reject a
    // save without the database being the first to notice.
    const draftMetadata: Record<string, unknown> = {}
    for (const definition of pluginFields) {
      const control = pluginInputs.get(definition.key)
      if (!control) continue
      const controlRecord = control as unknown as {
        readBoolean?: () => boolean
        value?: string
      }
      const raw =
        typeof controlRecord.readBoolean === 'function'
          ? controlRecord.readBoolean()
          : controlRecord.value ?? ''
      draftMetadata[definition.key] = raw
      const problem = definition.validate?.(raw, {
        name,
        price: minorToNumber(sellingPrice),
        cost_price: minorToNumber(costPrice),
        track_stock: trackStock,
        metadata: draftMetadata,
      })
      if (problem) {
        errorSlot.textContent = `${definition.label}: ${problem}`
        errorSlot.classList.remove('hidden')
        return
      }
    }

    saveButton.disabled = true
    try {
      // Uploaded here, after validation and after the plugin checks — never
      // before, so a save that was going to fail never spends a shop's data.
      const imageUrl = await imageField.commit()
      const payload = {
        name,
        sku: skuInput.value.trim() || null,
        description: descriptionInput.value.trim() || null,
        category_id: categoryCombo.value(),
        brand_id: brandCombo.value(),
        unit_id: unitSelect.value || null,
        tax_id: taxSelect.value || null,
        selling_price: minorToNumber(sellingPrice),
        cost_price: minorToNumber(costPrice),
        tax_inclusive: taxInclusiveBox.querySelector('input')?.checked ?? false,
        reorder_point: milliToNumber(reorderPoint),
        track_stock: trackStock,
        allow_negative: allowNegativeBox.querySelector('input')?.checked ?? false,
        is_active: activeBox.querySelector('input')?.checked ?? true,
        image_url: imageUrl,
        metadata: { ...(product?.metadata ?? {}), ...draftMetadata },
      }

      const saved = product
        ? await repos.products.update(product.id, payload)
        : await repos.products.create(payload)
      const detail = await repos.products.getWithVariants(saved.id)
      const defaultVariant = detail?.variants.find((entry) => entry.is_default) ?? detail?.variants[0]
      if (!defaultVariant) throw new Error('The product was saved without a default variant.')

      await repos.products.replaceBarcodes(defaultVariant.id, barcodeValues(barcodeInput.value))
      // A new product's field is an opening count; an existing product's is
      // the count on the shelf, so only the *difference* is written — and
      // it is written through the same ledger the Stock screen uses, never
      // as a balance this form sets by hand.
      const delta = milli((stockWanted ?? milli(0)) - (product && stockKnown ? stockBefore : milli(0)))
      if (trackStock && delta !== 0) {
        const warehouseId = salesFloor()?.warehouseId ?? (await repos.stock.listWarehouses())[0]?.id
        if (!warehouseId) throw new Error('The product was saved, but no stock location is available.')
        if (delta > 0) {
          await repos.stock.stockIn(
            warehouseId,
            [{ variantId: defaultVariant.id, qty: milli(delta), unitCost: costPrice }],
            { note: product ? 'Corrected from the product form' : 'Opening stock' }
          )
        } else {
          await repos.stock.adjust(
            warehouseId,
            defaultVariant.id,
            milli(-delta),
            'other',
            -1,
            'Corrected from the product form'
          )
        }
      }
      // The generated code is worth showing: it is the number the shelf label
      // and the supplier's order will carry, and the owner did not choose it.
      toastSuccess(
        product
          ? 'Product updated'
          : saved.sku
            ? `Product created · SKU ${saved.sku}`
            : 'Product created'
      )
      clearDraft(draftKey)
      dialog.close()
      onSaved()
    } catch (error) {
      errorSlot.textContent = translateError(error).message
      errorSlot.classList.remove('hidden')
      saveButton.disabled = false
    }
  }

  dialog.body.replaceChildren(
    h('div', { class: 'space-y-3' },
      field('Name', nameInput, { required: true }),
      h('div', { class: 'grid grid-cols-2 gap-3' },
        field('Selling price', priceInput, { required: true }),
        field('Cost price', costInput, { hint: 'Used for profit and stock value' })
      ),
      h('div', { class: 'grid grid-cols-2 gap-3' },
        field('Category', categoryCombo.root, { required: true }),
        field('Unit', unitSelect, { required: true })
      ),
      field('Brand', brandCombo.root, { hint: 'Optional · add a brand without leaving the form' }),
      field(product ? 'Stock on hand' : 'Opening stock', stockInput, {
        hint: product
          ? 'The count on the shelf. Change it here and the difference is recorded in the stock ledger.'
          : 'Received into the current stock location at the cost above.',
      }),
      field('Barcode(s)', barcodeInput, {
        hint: 'The first code becomes primary. Variant barcodes can be managed in Variants.',
      }),
      field('Product image', imageField.root, {
        hint: imageUploadsEnabled()
          ? 'Hosted on ImgBB — only the link is stored. Drag a photo in, or shoot one on a phone.'
          : 'Add an ImgBB key in Settings → Image uploads to enable product photos.',
      }),
      ...basicPluginFields.map(renderPluginField),
      pluginFormSectionsHost(registry, {
        organizationId: activeOrganization()?.organization_id ?? '',
        branchId: null,
        currency,
        ...(product?.id ? { productId: product.id } : {}),
      }),
      field('Description', descriptionInput),

      advancedToggle,
      advancedBody
    ),
    errorSlot
  )

  advancedBody.append(
    field('SKU', skuInput, {
      hint: 'Left blank, the shop numbers it: three letters of the name and a running number.',
    }),
    field('Tax', taxSelect),
    field('Reorder point', reorderInput),
    h('div', { class: 'col-span-2 space-y-2 pt-1' },
      taxInclusiveBox,
      trackStockBox,
      allowNegativeBox,
      activeBox
    ),
    ...advancedPluginFields.map(renderPluginField),
    pluginFormSectionsHost(
      registry,
      {
        organizationId: activeOrganization()?.organization_id ?? '',
        branchId: null,
        currency,
        ...(product?.id ? { productId: product.id } : {}),
      },
      'advanced'
    )
  )

  // Bind after every field exists, including the plugin-rendered ones.
  bindDrafts(dialog.body, draftKey)

  void (async () => {
    const busy = spinner('h-4 w-4')
    advancedBody.prepend(busy)
    try {
      const [initialCategories, b, u, t, barcodes] = await Promise.all([
        repos.catalog.listCategories(),
        repos.catalog.listBrands(),
        repos.catalog.listUnits(),
        repos.catalog.listTaxes(),
        product ? repos.products.listBarcodes(product.id) : Promise.resolve([]),
      ])
      let c = initialCategories
      if (c.length === 0) {
        const defaults = activeShopType()?.recommendations.categories ?? []
        const seeded = await Promise.all(
          defaults.map(async (name) => {
            try {
              return await repos.catalog.createCategory(name)
            } catch {
              return null
            }
          })
        )
        c = seeded.filter((item): item is Category => item !== null)
      }
      categories = c
      brands = b
      units = u
      taxes = t
      categoryCombo.setItems(categories)
      brandCombo.setItems(brands)
      categoryCombo.setValue(product?.category_id ?? null)
      brandCombo.setValue(product?.brand_id ?? null)
      const defaultUnitId = product?.unit_id ?? units.find((unit) => unit.name.toLowerCase() === 'each')?.id ?? null
      fill(unitSelect, units.map((x) => ({ value: x.id, label: `${x.name} (${x.symbol})` })), defaultUnitId)
      fill(taxSelect, taxes.map((x) => ({ value: x.id, label: `${x.name} (${x.rate}%)` })), product?.tax_id ?? null)
      barcodeInput.value = barcodes.map((barcode) => barcode.code).join('\\n')

      // What the shelf says right now, so the field can be corrected rather
      // than added to. Loaded after the rest: a stock table this role cannot
      // read must not stop the form from opening, it just leaves the field
      // behaving the way it does for a new product.
      if (product?.track_stock) {
        try {
          const levels = await repos.products.onHand([product.id], salesFloor()?.warehouseId ?? null)
          stockBefore = levels[product.id] ?? milli(0)
          stockKnown = true
          stockInput.value = formatQty(stockBefore, { decimal: true })
        } catch {
          stockKnown = false
        }
      }

      restoreDraft(dialog.body, draftKey)
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      busy.remove()
    }
  })()
}

function fill(
  target: HTMLSelectElement,
  options: { value: string; label: string }[],
  selected: string | null
): void {
  const placeholder = target.options[0]
  target.replaceChildren()
  if (placeholder) target.appendChild(placeholder)
  for (const option of options) {
    target.appendChild(h('option', { value: option.value, text: option.label }))
  }
  if (selected) target.value = selected
}
