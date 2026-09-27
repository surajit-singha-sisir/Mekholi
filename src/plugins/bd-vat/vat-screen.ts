/**
 * The Bangladesh VAT screen: status, the Mushak switch, and the guide.
 *
 * Order matters. The status card comes first because the only question a
 * shopkeeper brings here is "am I issuing proper VAT invoices or not?".
 * The switch comes second because it is the answer. The guide comes last
 * and longest, because the VAT system is the part nobody explains in the
 * shopkeeper's own terms — the form is easy once the system makes sense.
 *
 * Everything the switch writes goes to the same per-device invoice design
 * printer-setup edits, so the two screens can never disagree about what
 * the printer will do.
 */

import { h, mount } from '../../components/ui/h'
import { badge, card, cardHeader } from '../../components/ui/card'
import { field, input } from '../../components/ui/input'
import { toastSuccess, toastWarning } from '../../components/feedback/toast'
import { invoiceDesign, saveInvoiceDesign } from '../../shared/devices/device-config'

export interface VatScreenOptions {
  shopName: string
}

export function createVatScreen(options: VatScreenOptions): HTMLElement {
  let design = invoiceDesign()

  const root = h('div', { class: 'flex w-full flex-col gap-4 p-4' })
  const statusSlot = h('div', {})

  // ── Status ────────────────────────────────────────────────────────────
  function drawStatus(): void {
    const mushakOn = design.template === 'mushak'
    const hasBin = design.binNumber.trim().length > 0
    mount(
      statusSlot,
      card(
        cardHeader('This device', {
          subtitle: `What ${options.shopName}'s printer will put on the next sale`,
        }),
        h(
          'div',
          { class: 'flex flex-wrap items-center gap-2' },
          mushakOn
            ? badge('Mushak-6.3 VAT invoice', { tone: 'success', iconName: 'verified' })
            : badge('Ordinary receipt', { tone: 'neutral', iconName: 'receipt' }),
          hasBin
            ? badge(`BIN ${design.binNumber.trim()}`, { tone: 'success', iconName: 'badge' })
            : badge('No BIN set', { tone: mushakOn ? 'danger' : 'neutral', iconName: 'badge' }),
          mushakOn && !hasBin
            ? h('p', {
                class: 'w-full text-xs text-danger',
                text: 'A Mushak-6.3 with no BIN is not a VAT invoice. Enter the BIN below or switch back to the ordinary receipt.',
              })
            : null
        )
      )
    )
  }

  // ── The switch ────────────────────────────────────────────────────────
  const binBox = input({
    value: design.binNumber,
    placeholder: '0012345678-0101',
    maxlength: 20,
  })
  binBox.addEventListener('change', () => {
    design = { ...design, binNumber: binBox.value.trim() }
    saveInvoiceDesign(design)
    drawStatus()
    if (design.binNumber && design.template !== 'mushak') {
      toastSuccess('BIN saved — it will print on the receipt header.')
    }
  })

  const toggle = h('input', { type: 'checkbox' }) as HTMLInputElement
  toggle.checked = design.template === 'mushak'
  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      design = { ...design, template: 'mushak' }
      saveInvoiceDesign(design)
      if (!design.binNumber.trim()) {
        toastWarning('Mushak-6.3 is on, but the form needs your BIN to mean anything.')
      } else {
        toastSuccess('This device now prints Mushak-6.3 VAT invoices.')
      }
    } else {
      // Falling back to 'standard' rather than remembering the previous
      // template: the shop turning VAT invoicing off is making a simple
      // statement, and 'standard' is the simple receipt.
      design = { ...design, template: 'standard' }
      saveInvoiceDesign(design)
      toastSuccess('Back to the ordinary receipt.')
    }
    drawStatus()
  })

  const switchCard = card(
    cardHeader('Mushak-6.3 on this device', { subtitle: 'The NBR tax invoice, prescribed by the VAT & SD Act 2012' }),
    h(
      'div',
      { class: 'flex flex-col gap-4' },
      h(
        'label',
        { class: 'flex cursor-pointer items-center justify-between gap-3' },
        h(
          'span',
          { class: 'text-sm text-content' },
          'Print every sale as a ',
          h('strong', { text: 'মূসক-৬.৩ VAT invoice' }),
          h('span', {
            class: 'block text-xs text-content-muted',
            text: 'Adds the form heading and your BIN. Never changes any amount — VAT comes from each product’s own rate.',
          })
        ),
        toggle
      ),
      field('BIN (Business Identification Number)', binBox, {
        hint: 'Your 9–13 digit NBR VAT registration. Leave empty if the shop is not VAT-registered — and leave Mushak off too.',
      })
    )
  )

  // ── The guide ─────────────────────────────────────────────────────────
  const line = (label: string, text: string): HTMLElement =>
    h(
      'div',
      { class: 'flex gap-3 border-b border-border py-2 last:border-b-0' },
      h('p', { class: 'w-28 shrink-0 text-xs font-semibold text-content-muted', text: label }),
      h('p', { class: 'text-sm text-content', text })
    )

  const guideCard = card(
    cardHeader('The মূসক system in plain words', { subtitle: 'Condensed from docs/18 — confirm your own band with your VAT circle' }),
    h(
      'div',
      {},
      h('h4', { class: 'mt-1 text-sm font-semibold text-content', text: 'Rates' }),
      line('15%', 'The standard rate, on most goods and services. Shelf prices in Bangladesh usually include it — set the product’s VAT as “inclusive” and the sticker price stays the sticker price.'),
      line('Truncated', 'Sector rates (5%, 7.5%, 10% and others) where the law fixes a lower rate and gives up the input credit. Set the product’s rate to match its sector.'),
      line('0% / exempt', 'Exports are zero-rated; First-Schedule basics are exempt. Both print ৳0.00 VAT — the Mushak form states the zero rather than hiding it.'),

      h('h4', { class: 'mt-4 text-sm font-semibold text-content', text: 'Who must register' }),
      line('Small', 'Below the enlistment threshold (৳50 lakh under the 2025 revision; the older NBR FAQ says ৳30 lakh): outside the VAT net. No BIN, no Mushak — use the ordinary receipt.'),
      line('Middle', 'Enlisted for Turnover Tax (up to ৳3 crore; older figure ৳80 lakh): a few percent on gross turnover, no VAT charged to customers, quarterly Mushak 9.2. Still no Mushak-6.3.'),
      line('Registered', 'Above the threshold, or in a scheduled activity: full VAT registration, a BIN, Mushak-6.3 with every sale, monthly Mushak 9.1 return by the 15th.'),

      h('h4', { class: 'mt-4 text-sm font-semibold text-content', text: 'The forms a shop meets' }),
      line('Mushak 6.3', 'The tax invoice this plugin switches on: seller name and BIN, serial number, date and time, the items, the VAT stated — the customer’s proof for input credit, and yours to the NBR.'),
      line('Mushak 6.1/6.2', 'The purchase and sales registers, kept current. Mekholi’s purchase and sales histories carry the same facts.'),
      line('Mushak 9.1', 'The monthly return that reconciles output VAT against input credit. Keep invoices at least 5 years.'),

      h('p', {
        class: 'mt-4 rounded-lg border border-border bg-surface-muted p-3 text-xs text-content-muted',
        text: 'This guide is orientation, not tax advice. Thresholds and truncated rates move with each Finance Act — the NBR (nbr.gov.bd) and your VAT circle have the current word.',
      })
    )
  )

  drawStatus()
  root.append(statusSlot, switchCard, guideCard)
  return root
}
