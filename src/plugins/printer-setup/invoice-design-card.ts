/**
 * Choosing what the invoice looks like — the part that was missing.
 *
 * Printer setup could pair a printer and send a test page, but nothing on it
 * decided what the paper actually said. The shop name came from the
 * organisation record, the footer was always "Thank you", and an address
 * could not be printed at all.
 *
 * ── The shape of the screen ──────────────────────────────────────────────
 * Template first, as three cards rather than a dropdown: the difference
 * between Compact and Detailed is visual, so it is chosen visually, and the
 * live preview beside it re-renders on every change. A shopkeeper should not
 * have to spend a roll of paper to find out what a setting does.
 *
 * The preview is the real renderer — `renderReceipt` with the real stylesheet
 * — not an impression of it. A preview drawn by different code is a preview
 * that will eventually lie.
 */

import { h, mount } from '../../components/ui/h'
import { card, cardHeader } from '../../components/ui/card'
import { checkbox, field, input, select, textarea } from '../../components/ui/input'
import { invoiceDesign, saveInvoiceDesign } from '../../shared/devices/device-config'
import {
  INVOICE_TEMPLATES,
  type InvoiceDesign,
  type InvoiceTemplate,
} from '../../shared/receipt/design'
import { receiptCss, renderReceipt } from '../../shared/receipt/receipt'
import { sampleReceipt } from '../../shared/receipt/sample'

export interface InvoiceDesignOptions {
  /** The shop's name, used when the design does not override it. */
  shopName: string
  /** Told after every change, so the page can redraw anything else that cares. */
  onChange?: (design: InvoiceDesign) => void
}

export function invoiceDesignCard(options: InvoiceDesignOptions): HTMLElement {
  let design = invoiceDesign()

  const previewHost = h('div', {
    class: 'overflow-x-auto rounded-lg border border-border bg-white p-3',
  })
  const templateHost = h('div', { class: 'grid gap-2 sm:grid-cols-2' })

  function persist(patch: Partial<InvoiceDesign>): void {
    design = { ...design, ...patch }
    saveInvoiceDesign(design)
    drawTemplates()
    drawPreview()
    options.onChange?.(design)
  }

  function drawPreview(): void {
    const data = sampleReceipt(design.shopName.trim() || options.shopName)
    mount(
      previewHost,
      // The stylesheet travels with the preview: these class names are the
      // receipt's own, not Tailwind's, and nothing else on the page defines
      // them.
      h('div', {}, h('style', { text: receiptCss(design) }), renderReceipt(data, design))
    )
  }

  /**
   * The three templates as pressable cards.
   *
   * `aria-pressed` rather than a radio group: they behave like a toolbar of
   * choices, and a radio group would need a visible legend to be read
   * correctly, which the card header already is.
   */
  function drawTemplates(): void {
    // Mushak-6.3 is switched on from the bd-vat plugin's own screen, where
    // the BIN and the guide live — a tax form should be chosen next to the
    // things that make it lawful. It still *shows* here while it is the
    // active template, so this card never lies about what the printer does
    // and never strands a shop whose plugin was later switched off.
    const templates = INVOICE_TEMPLATES.filter(
      (template) => template.value !== 'mushak' || design.template === 'mushak'
    )
    mount(
      templateHost,
      ...templates.map((template) =>
        h('button', {
          type: 'button',
          'data-template': template.value,
          'aria-pressed': String(design.template === template.value),
          class:
            'rounded-lg border p-3 text-left transition ' +
            (design.template === template.value
              ? 'border-primary bg-primary/5 ring-1 ring-primary'
              : 'border-border bg-surface hover:border-content-subtle'),
          onclick: () => persist({ template: template.value as InvoiceTemplate }),
        },
          h('p', { class: 'text-sm font-medium text-content', text: template.label }),
          h('p', { class: 'mt-0.5 text-xs text-content-muted', text: template.blurb })
        )
      )
    )
  }

  const shopNameBox = input({
    value: design.shopName,
    placeholder: options.shopName,
    maxlength: 40,
  })
  shopNameBox.addEventListener('change', () => persist({ shopName: shopNameBox.value }))

  const headerBox = textarea({
    rows: 3,
    value: design.headerLines,
    placeholder: '123 Station Road, Sunamganj\n01712-345678',
  })
  headerBox.addEventListener('change', () => persist({ headerLines: headerBox.value }))

  const footerBox = input({ value: design.footerText, placeholder: 'Thank you', maxlength: 60 })
  footerBox.addEventListener('change', () => persist({ footerText: footerBox.value }))

  const binBox = input({
    value: design.binNumber,
    placeholder: '0012345678901',
    maxlength: 20,
  })
  binBox.addEventListener('change', () => persist({ binNumber: binBox.value.trim() }))

  const scaleBox = select({
    value: String(design.fontScale),
    options: [
      { value: '0.9', label: 'Small — fits more on a 58mm roll' },
      { value: '1', label: 'Normal' },
      { value: '1.15', label: 'Large — easier to read' },
      { value: '1.3', label: 'Largest' },
    ],
    onChange: (value) => persist({ fontScale: Number(value) }),
  })

  drawTemplates()
  drawPreview()

  return card(
    cardHeader('Invoice design', {
      iconName: 'receipt_long',
      subtitle: 'What the printed slip says, and how much of it. Saved on this device, beside the printer.',
    }),

    h('div', { class: 'space-y-4' },
      templateHost,

      h('div', { class: 'grid gap-3 sm:grid-cols-2' },
        field('Shop name on the receipt', shopNameBox, {
          hint: `Leave empty to use “${options.shopName}”.`,
        }),
        field('Text size', scaleBox, {
          hint: 'A 58mm roll usually needs Small to keep the columns apart.',
        })
      ),

      field('Under the name', headerBox, {
        hint: 'Address, phone — one per line. Not printed by the Compact template.',
      }),
      field('BIN (VAT registration)', binBox, {
        hint: 'Printed as “BIN: …” under the header. A Mushak-6.3 invoice needs it; leave empty if the shop is not VAT-registered.',
      }),
      field('Last line', footerBox, { hint: 'Leave empty for no footer at all.' }),

      h('div', { class: 'grid gap-2 sm:grid-cols-2' },
        checkbox({
          checked: design.showCustomer,
          label: 'Print who the sale was to',
          onChange: (value) => persist({ showCustomer: value }),
        }),
        checkbox({
          checked: design.showCashier,
          label: 'Print which cashier served it',
          onChange: (value) => persist({ showCashier: value }),
        }),
        checkbox({
          checked: design.showUnitPrice,
          label: 'Print the unit price beside each quantity',
          onChange: (value) => persist({ showUnitPrice: value }),
        }),
        checkbox({
          checked: design.showItemNotes,
          label: 'Print plugin notes under a line',
          onChange: (value) => persist({ showItemNotes: value }),
        })
      ),

      h('div', {},
        h('p', { class: 'mb-2 text-xs font-medium text-content-muted', text: 'Preview' }),
        previewHost
      )
    )
  )
}
