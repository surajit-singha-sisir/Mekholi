/**
 * The label screen: choose products, choose the paper, print.
 *
 * The workflow is a shelf walk: search, tick, set how many, print one sheet.
 * Everything is chosen on this screen and nothing is remembered between
 * visits — a label run is a task, not a configuration, and the paper in the
 * printer today is not the paper that will be in it next month.
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
import { formatMoney, minor, type Minor } from '../../shared/domain/money'
import type {
  PluginDb,
  PluginPageContext,
  PluginPageModule,
  ProductSnapshot,
} from '../../shared/registry/plugin-types'
import { code128Encodable } from './code128'
import { buildLabelSheet, countLabels, labelSize, LABEL_SIZES, type LabelItem } from './sheet'

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

      let search = ''
      let sizeId = LABEL_SIZES[0]?.id ?? 'a4-38x21'
      let showPrice = true
      let printShopName = true
      /** Product id → number of copies. Presence means selected. */
      const chosen = new Map<string, number>()

      const money = (price: number | null): string | null =>
        price === null
          ? null
          : formatMoney(minor(Math.round(price * 100) as Minor), { currency: ctx.currency })

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
        const result = printDocument(
          buildLabelSheet(items, labelSize(sizeId), {
            shopName: printShopName ? ctx.organizationName : '',
            showPrice,
          }),
          'Labels'
        )
        if (result.ok) toastSuccess('The label sheet is ready in the print window.')
        else toastError(result.reason ?? 'The print window could not be opened.')
      }

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

      const sizeBox = select({
        value: sizeId,
        options: LABEL_SIZES.map((size) => ({ value: size.id, label: size.label })),
        onChange: (value) => {
          sizeId = value
        },
      })

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

      draw()

      return h('div', { class: 'flex w-full min-w-0 flex-col gap-3 p-4' },
        h('div', { class: 'flex flex-wrap items-end gap-3' },
          h('div', { class: 'flex-1 min-w-[12rem] max-w-sm' },
            searchInput('Search by name or SKU', (value) => {
              search = value
              draw()
            })
          ),
          field('Label size', sizeBox),
          h('div', { class: 'flex flex-col gap-1 pb-1' },
            checkbox({ checked: showPrice, label: 'Print the price', onChange: (value) => { showPrice = value } }),
            checkbox({ checked: printShopName, label: 'Print the shop name', onChange: (value) => { printShopName = value } })
          )
        ),
        h('div', { class: 'flex flex-wrap items-center gap-2' }, selectAll, clearAll, h('div', { class: 'flex-1' }), printButton),
        listBox
      )
    },
  }
}
