/**
 * The label screen: choose products, choose the paper, shape the label, print.
 *
 * The workflow is a shelf walk: search, tick, set how many, print one sheet.
 * The *shape* of the label, though, is a decision the shop makes once — which
 * paper, what the label says, how big the writing is — so those settings are
 * remembered on this device between visits. The product selection is not: a
 * label run is a task, and today's run is not next week's.
 *
 * A live preview shows one label exactly as the printer will shape it,
 * because label stock is the one paper a shop cannot un-waste: a wrong guess
 * costs a strip of stickers, a preview costs nothing.
 *
 * Products without a SKU are shown rather than hidden, greyed out with the
 * reason: the screen that prints barcodes is exactly where a shopkeeper
 * discovers which items cannot have one yet, and the fix (give it a SKU) is
 * one edit away in Products.
 */

import { h } from '../../components/ui/h'
import { button } from '../../components/ui/button'
import { searchInput, select, checkbox, field } from '../../components/ui/input'
import { emptyState, panel } from '../../components/ui/card'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { printDocument } from '../../shared/export/download'
import { formatMoney, minor } from '../../shared/domain/money'
import type {
  PluginDb,
  PluginPageContext,
  PluginPageModule,
  ProductSnapshot,
} from '../../shared/registry/plugin-types'
import { code128Encodable } from './code128'
import {
  buildLabelSheet,
  countLabels,
  customLabelSize,
  labelSize,
  LABEL_SIZES,
  type LabelItem,
  type LabelSize,
  type SheetOptions,
} from './sheet'

/** What this device remembers about how its labels are shaped. */
interface LabelSettings {
  sizeId: string
  customW: number
  customH: number
  customPage: 'a4' | 'roll'
  showPrice: boolean
  showName: boolean
  showShop: boolean
  skuText: boolean
  mrp: boolean
  packedDate: boolean
  noteLine: string
  fontScale: number
  skipCells: number
}

const DEFAULTS: LabelSettings = {
  sizeId: LABEL_SIZES[0]?.id ?? 'a4-38x21',
  customW: 40,
  customH: 25,
  customPage: 'roll',
  showPrice: true,
  showName: true,
  showShop: true,
  skuText: false,
  mrp: false,
  packedDate: false,
  noteLine: '',
  fontScale: 1,
  skipCells: 0,
}

const SETTINGS_KEY = 'mekholi.label-printing.settings.v1'

function loadSettings(): LabelSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LabelSettings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveSettings(settings: LabelSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // A full or blocked storage loses the memory, never the print.
  }
}

export function createLabelsScreen({ db }: { db: PluginDb }): PluginPageModule {
  return {
    async render(ctx: PluginPageContext): Promise<HTMLElement> {
      let products: ProductSnapshot[] = []
      try {
        products = (await db.products()).filter((product) => product.is_active)
      } catch {
        return h('div', { class: 'p-4' },
          emptyState('The catalogue could not be read', {
            description: 'Check the connection and open the screen again.',
            iconName: 'error',
          })
        )
      }

      const settings = loadSettings()
      let search = ''
      /** Product id → number of copies. Presence means selected. */
      const chosen = new Map<string, number>()

      // `plugin_products` sends the price in MINOR units (paisa) — migration
      // 048's contract, "like every money value that crosses to a client".
      // This screen once multiplied by 100 on top of that, which printed
      // ৳25,000 shelf labels for a ৳250 bottle of oil.
      const money = (price: number | null): string | null =>
        price === null
          ? null
          : formatMoney(minor(Math.round(price)), { currency: ctx.currency })

      const visible = (): ProductSnapshot[] => {
        const term = search.trim().toLowerCase()
        if (!term) return products
        return products.filter(
          (product) =>
            product.name.toLowerCase().includes(term) ||
            (product.sku ?? '').toLowerCase().includes(term)
        )
      }

      const printable = (product: ProductSnapshot): boolean =>
        Boolean(product.sku && code128Encodable(product.sku))

      function currentSize(): LabelSize {
        return settings.sizeId === 'custom'
          ? customLabelSize(settings.customW, settings.customH, settings.customPage)
          : labelSize(settings.sizeId)
      }

      function sheetOptions(): SheetOptions {
        return {
          shopName: settings.showShop ? ctx.organizationName : '',
          showPrice: settings.showPrice,
          showName: settings.showName,
          skuText: settings.skuText || currentSize().showText,
          mrp: settings.mrp,
          noteLine: settings.noteLine,
          packedDate: settings.packedDate
            ? `Packed: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`
            : '',
          fontScale: settings.fontScale,
          skipCells: settings.skipCells,
        }
      }

      const listBox = h('div')
      const printButton = button('Print', { variant: 'primary', icon: 'print', onClick: () => print() })

      function chosenItems(): LabelItem[] {
        const items: LabelItem[] = []
        for (const product of products) {
          const copies = chosen.get(product.id)
          if (copies === undefined || !product.sku) continue
          items.push({
            name: product.name,
            sku: product.sku,
            price: money(product.price),
            copies,
          })
        }
        return items
      }

      function refreshPrintButton(): void {
        const total = countLabels(chosenItems())
        printButton.textContent = total > 0 ? `Print ${total} label${total === 1 ? '' : 's'}` : 'Print'
        if (total === 0) printButton.setAttribute('disabled', 'true')
        else printButton.removeAttribute('disabled')
      }

      function print(): void {
        const items = chosenItems()
        if (items.length === 0) return
        saveSettings(settings)
        const result = printDocument(buildLabelSheet(items, currentSize(), sheetOptions()), 'Labels')
        if (result.ok) toastSuccess('The label sheet is ready in the print window.')
        else toastError(result.reason ?? 'The print window could not be opened.')
      }

      // ── Live preview ─────────────────────────────────────────────────────
      // One label, real millimetres, in an iframe so its print CSS cannot
      // bleed into the app (and the app's cannot bleed into it).
      const previewBox = h('div', { class: 'flex items-center justify-center rounded-lg border border-dashed border-border bg-surface-muted p-3 min-h-[7rem] overflow-auto' })

      function previewItem(): LabelItem {
        for (const product of products) {
          if (chosen.has(product.id) && product.sku && code128Encodable(product.sku)) {
            return { name: product.name, sku: product.sku, price: money(product.price), copies: 1 }
          }
        }
        return { name: 'Miniket Rice 5kg', sku: 'RICE-5KG', price: money(45_000), copies: 1 }
      }

      function refreshPreview(): void {
        const size = currentSize()
        // The preview is always one label on its own page, whatever the paper.
        const one: LabelSize = { ...size, page: 'roll' }
        const iframe = h('iframe', {
          title: 'Label preview',
          class: 'border border-border bg-white shadow-sm',
          style: `width: ${size.widthMm}mm; height: ${size.heightMm}mm;`,
        }) as HTMLIFrameElement
        iframe.setAttribute('srcdoc', buildLabelSheet([previewItem()], one, { ...sheetOptions(), skipCells: 0 }))
        previewBox.replaceChildren(
          h('div', { class: 'flex flex-col items-center gap-1' },
            iframe,
            h('p', { class: 'text-[11px] text-content-subtle', text: `${size.widthMm} × ${size.heightMm} mm — actual size` })
          )
        )
      }

      function settingChanged(): void {
        saveSettings(settings)
        refreshPreview()
      }

      // ── The paper ────────────────────────────────────────────────────────
      const customWBox = numberBox(settings.customW, 20, 150, (value) => { settings.customW = value; settingChanged() })
      const customHBox = numberBox(settings.customH, 12, 150, (value) => { settings.customH = value; settingChanged() })
      const customPageBox = select({
        value: settings.customPage,
        options: [
          { value: 'roll', label: 'Roll — one label per page' },
          { value: 'a4', label: 'A4 sheet — labels flow and wrap' },
        ],
        onChange: (value) => { settings.customPage = value === 'a4' ? 'a4' : 'roll'; settingChanged(); refreshPaperRows() },
      })
      const customRow = h('div', { class: 'flex flex-wrap items-end gap-2' },
        field('Width (mm)', customWBox), field('Height (mm)', customHBox), field('Paper', customPageBox)
      )

      const skipBox = numberBox(settings.skipCells, 0, 200, (value) => { settings.skipCells = value; settingChanged() })
      const skipRow = field('Skip used stickers', skipBox, {
        hint: 'A partly used A4 sheet: how many cells are already gone.',
      })

      function refreshPaperRows(): void {
        customRow.classList.toggle('hidden', settings.sizeId !== 'custom')
        const a4 = settings.sizeId === 'custom' ? settings.customPage === 'a4' : currentSize().page === 'a4'
        skipRow.classList.toggle('hidden', !a4)
      }

      const sizeBox = select({
        value: settings.sizeId,
        options: [
          ...LABEL_SIZES.map((size) => ({ value: size.id, label: size.label })),
          { value: 'custom', label: 'Custom size…' },
        ],
        onChange: (value) => {
          settings.sizeId = value
          refreshPaperRows()
          settingChanged()
        },
      })

      // ── What the label says ──────────────────────────────────────────────
      const noteBox = h('input', {
        type: 'text',
        maxlength: '60',
        value: settings.noteLine,
        placeholder: 'e.g. a phone number or address',
        class:
          'w-full h-11 rounded-md border border-input bg-surface px-3 text-base text-content sm:text-sm ' +
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'aria-label': 'Extra line on every label',
      }) as HTMLInputElement
      noteBox.addEventListener('input', () => { settings.noteLine = noteBox.value; settingChanged() })

      const scaleBox = select({
        value: String(settings.fontScale),
        options: [
          { value: '0.85', label: 'Small' },
          { value: '1', label: 'Normal' },
          { value: '1.2', label: 'Large' },
        ],
        onChange: (value) => { settings.fontScale = Number(value) || 1; settingChanged() },
      })

      const toggle = (label: string, key: keyof Pick<LabelSettings, 'showShop' | 'showName' | 'showPrice' | 'mrp' | 'skuText' | 'packedDate'>): HTMLElement =>
        checkbox({
          checked: settings[key],
          label,
          onChange: (value) => { settings[key] = value; settingChanged() },
        })

      const settingsPanel = panel(
        h('div', { class: 'grid gap-4 p-3 sm:grid-cols-2 lg:grid-cols-3' },
          h('div', { class: 'space-y-2' },
            h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-content-muted', text: 'The paper' }),
            field('Label size', sizeBox),
            customRow,
            skipRow
          ),
          h('div', { class: 'space-y-2' },
            h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-content-muted', text: 'What the label says' }),
            h('div', { class: 'grid grid-cols-1 gap-1.5' },
              toggle('Shop name', 'showShop'),
              toggle('Product name', 'showName'),
              toggle('Price', 'showPrice'),
              toggle('Write MRP before the price', 'mrp'),
              toggle('SKU digits under the barcode', 'skuText'),
              toggle('Packed date (today)', 'packedDate')
            ),
            field('Extra line', noteBox, { hint: 'Printed small on every label. Leave blank to omit.' }),
            field('Text size', scaleBox)
          ),
          h('div', { class: 'space-y-2' },
            h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-content-muted', text: 'Preview' }),
            previewBox
          )
        )
      )

      // ── Selection tools ──────────────────────────────────────────────────
      const selectAll = button('Select all shown', {
        variant: 'outline',
        icon: 'select_check_box',
        onClick: () => {
          for (const product of visible()) {
            if (printable(product) && !chosen.has(product.id)) chosen.set(product.id, 1)
          }
          draw()
        },
      })
      const clearAll = button('Clear', {
        variant: 'ghost',
        onClick: () => {
          chosen.clear()
          draw()
        },
      })

      const copiesAllBox = numberBox(1, 1, 999, () => {})
      const copiesAll = button('Set copies for selected', {
        variant: 'outline',
        icon: 'content_copy',
        onClick: () => {
          const value = Math.max(1, Math.min(999, Math.floor(Number(copiesAllBox.value) || 1)))
          for (const id of chosen.keys()) chosen.set(id, value)
          draw()
        },
      })

      function row(product: ProductSnapshot): HTMLElement {
        const can = printable(product)
        const copies = chosen.get(product.id)

        const tick = h('input', {
          type: 'checkbox',
          class: 'h-4 w-4 accent-primary',
          'aria-label': `Print labels for ${product.name}`,
          ...(copies !== undefined ? { checked: 'true' } : {}),
          ...(can ? {} : { disabled: 'true' }),
        }) as HTMLInputElement
        tick.addEventListener('change', () => {
          if (tick.checked) chosen.set(product.id, chosen.get(product.id) ?? 1)
          else chosen.delete(product.id)
          draw()
          refreshPreview()
        })

        const copiesBox = h('input', {
          type: 'number',
          min: '1',
          max: '999',
          value: String(copies ?? 1),
          class:
            'w-16 rounded-md border border-border bg-surface px-2 py-1 text-right text-sm ' +
            'text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'aria-label': `Copies for ${product.name}`,
          ...(copies === undefined ? { disabled: 'true' } : {}),
        }) as HTMLInputElement
        copiesBox.addEventListener('change', () => {
          const value = Math.max(1, Math.min(999, Math.floor(Number(copiesBox.value) || 1)))
          copiesBox.value = String(value)
          if (chosen.has(product.id)) {
            chosen.set(product.id, value)
            refreshPrintButton()
          }
        })

        return h('tr', { class: `border-b border-border ${can ? '' : 'opacity-50'}` },
          h('td', { class: 'px-3 py-2' }, tick),
          h('td', { class: 'px-3 py-2' },
            h('p', { class: 'font-medium text-content', text: product.name }),
            can
              ? h('p', { class: 'text-xs text-content-muted font-mono', text: product.sku ?? '' })
              : h('p', {
                  class: 'text-xs text-content-muted',
                  text: product.sku
                    ? 'This SKU has characters a barcode cannot carry.'
                    : 'No SKU — give it one in Products and it can have a label.',
                })
          ),
          h('td', { class: 'px-3 py-2 text-right text-sm text-content-muted', text: money(product.price) ?? '—' }),
          h('td', { class: 'px-3 py-2 text-right' }, copiesBox)
        )
      }

      function draw(): void {
        const rows = visible()
        if (rows.length === 0) {
          listBox.replaceChildren(
            emptyState(search ? 'No products match that search' : 'No products yet', {
              description: search
                ? 'Try a different name or SKU.'
                : 'Add products first — labels are printed from their SKUs.',
              iconName: 'label',
            })
          )
          refreshPrintButton()
          return
        }

        listBox.replaceChildren(
          panel(
            h('div', { class: 'w-full min-w-0 overflow-x-auto' },
              h('table', { class: 'w-full table-auto text-sm' },
                h('thead', { class: 'text-left text-xs text-content-muted border-b border-border' },
                  h('tr', {},
                    h('th', { class: 'px-3 py-2' }),
                    h('th', { class: 'px-3 py-2 font-medium', text: 'Product' }),
                    h('th', { class: 'px-3 py-2 font-medium text-right', text: 'Price' }),
                    h('th', { class: 'px-3 py-2 font-medium text-right', text: 'Copies' })
                  )
                ),
                h('tbody', {}, ...rows.map(row))
              )
            )
          )
        )
        refreshPrintButton()
      }

      refreshPaperRows()
      refreshPreview()
      draw()

      return h('div', { class: 'flex w-full min-w-0 flex-col gap-3 p-4' },
        settingsPanel,
        h('div', { class: 'flex flex-wrap items-center gap-2' },
          h('div', { class: 'flex-1 min-w-[12rem] max-w-sm' },
            searchInput('Search by name or SKU', (value) => {
              search = value
              draw()
            })
          ),
          selectAll,
          clearAll,
          h('div', { class: 'flex items-center gap-1' }, copiesAllBox, copiesAll),
          h('div', { class: 'flex-1' }),
          printButton
        ),
        listBox
      )
    },
  }
}

/** A small clamped number input, the same everywhere it appears above. */
function numberBox(
  value: number,
  min: number,
  max: number,
  onChange: (value: number) => void
): HTMLInputElement {
  const box = h('input', {
    type: 'number',
    min: String(min),
    max: String(max),
    value: String(value),
    class:
      'w-20 h-11 rounded-md border border-input bg-surface px-2 text-right text-base text-content ' +
      'sm:text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  }) as HTMLInputElement
  box.addEventListener('change', () => {
    const next = Math.max(min, Math.min(max, Math.floor(Number(box.value) || min)))
    box.value = String(next)
    onChange(next)
  })
  return box
}
