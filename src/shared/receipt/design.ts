/**
 * What the printed invoice looks like.
 *
 * The receipt layout used to be a constant: one template, 80mm, "Thank you"
 * at the bottom, shop name from the organisation record. That is fine until a
 * shop has an address it must print, a hotline it wants on every slip, or a
 * 58mm roll where three lines per item will not fit.
 *
 * ── Why a template *and* toggles ──────────────────────────────────────────
 * A single list of switches makes the shopkeeper design a receipt, which is
 * not their job and not their interest. A single template list makes them
 * choose between three things none of which is quite right. So the template
 * is the decision — how much detail, in one word — and the toggles handle the
 * facts only this shop knows: its address, its footer, whether the cashier's
 * name goes on the slip.
 *
 * ── Why this lives with the device settings ──────────────────────────────
 * Paper width belongs to the printer, and the printer belongs to the machine
 * at the counter, not to the organisation: the same shop may have an 80mm
 * till printer and a 58mm handheld. So the design is stored per device,
 * beside the printer it prints on.
 */

export type InvoiceTemplate = 'compact' | 'standard' | 'detailed' | 'mushak'

export interface InvoiceDesign {
  template: InvoiceTemplate
  /** Printed as the heading. Empty means "use the shop's own name". */
  shopName: string
  /** Address, phone, VAT number — one per line, printed under the heading. */
  headerLines: string
  /**
   * The shop's BIN (Business Identification Number — the NBR VAT
   * registration). Printed as its own line whenever the template prints a
   * header, because a slip that is asked for a BIN is asked for it every
   * time; on the Mushak-6.3 template it is part of what makes the document a
   * VAT invoice at all. Empty means the shop is not VAT-registered, and the
   * line simply does not print.
   */
  binNumber: string
  /** Who the sale was to. Off for a shop that sells to the queue. */
  showCustomer: boolean
  /** Which cashier served it — useful with staff, noise without. */
  showCashier: boolean
  /** Plugin values under a line: a batch number, a warranty code. */
  showItemNotes: boolean
  /** The unit price beside each quantity. Off is the compact look. */
  showUnitPrice: boolean
  /** The last line. "Thank you" unless the shop says otherwise. */
  footerText: string
  /** 0.8–1.4. A 58mm roll often needs 0.9 to hold the columns. */
  fontScale: number
}

export const DEFAULT_INVOICE_DESIGN: InvoiceDesign = {
  template: 'standard',
  shopName: '',
  headerLines: '',
  binNumber: '',
  showCustomer: true,
  showCashier: false,
  showItemNotes: true,
  showUnitPrice: true,
  footerText: 'Thank you',
  fontScale: 1,
}

/** The three templates, as the setup screen lists them. */
export const INVOICE_TEMPLATES: Array<{ value: InvoiceTemplate; label: string; blurb: string }> = [
  {
    value: 'compact',
    label: 'Compact',
    blurb: 'One line per item, no extras. The shortest slip that is still a receipt — least paper, fastest print.',
  },
  {
    value: 'standard',
    label: 'Standard',
    blurb: 'Item, quantity and price on separate lines, with totals underneath. What most counters print.',
  },
  {
    value: 'detailed',
    label: 'Detailed',
    blurb: 'Everything: shop address, cashier, per-line notes and looser spacing. For a slip that doubles as a document.',
  },
  {
    value: 'mushak',
    label: 'Mushak-6.3 (VAT)',
    blurb: 'The NBR VAT invoice: BIN, the VAT amount on every sale, and a heading that names the form. For the VAT-registered shop.',
  },
]

/**
 * The template's own opinions, before the shop's toggles are applied.
 *
 * Kept as data rather than branches in the renderer so that "what does
 * Compact actually do?" has one answer, in one place, that a test can read.
 */
export function templateRules(template: InvoiceTemplate): {
  oneLinePerItem: boolean
  headerLines: boolean
  cashier: boolean
  itemNotes: boolean
  lineHeight: number
} {
  switch (template) {
    case 'compact':
      return { oneLinePerItem: true, headerLines: false, cashier: false, itemNotes: false, lineHeight: 1.3 }
    case 'detailed':
      return { oneLinePerItem: false, headerLines: true, cashier: true, itemNotes: true, lineHeight: 1.6 }
    case 'mushak':
      // The VAT invoice: full seller header, per-line detail, and the notes
      // plugins print (a batch number belongs on a tax document). The
      // cashier's name is not part of the form.
      return { oneLinePerItem: false, headerLines: true, cashier: false, itemNotes: true, lineHeight: 1.45 }
    case 'standard':
    default:
      return { oneLinePerItem: false, headerLines: true, cashier: false, itemNotes: true, lineHeight: 1.45 }
  }
}

/**
 * What the renderer should actually draw: the template's rules narrowed by
 * the shop's switches. A switch may take something away, never add it back —
 * "Compact" that printed per-line notes because a checkbox was left on would
 * make the template list meaningless.
 */
export function resolveDesign(design: InvoiceDesign): {
  oneLinePerItem: boolean
  headerLines: string[]
  /** True when the slip must present itself as a Mushak-6.3 VAT invoice. */
  mushak: boolean
  /** Empty when unset, or when the template prints no header at all. */
  binNumber: string
  showCustomer: boolean
  showCashier: boolean
  showItemNotes: boolean
  showUnitPrice: boolean
  footerText: string
  fontScale: number
  lineHeight: number
} {
  const rules = templateRules(design.template)
  return {
    oneLinePerItem: rules.oneLinePerItem,
    mushak: design.template === 'mushak',
    binNumber: rules.headerLines ? design.binNumber.trim() : '',
    headerLines: rules.headerLines
      ? design.headerLines
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
    showCustomer: design.showCustomer,
    showCashier: rules.cashier && design.showCashier,
    showItemNotes: rules.itemNotes && design.showItemNotes,
    showUnitPrice: !rules.oneLinePerItem && design.showUnitPrice,
    footerText: design.footerText.trim(),
    fontScale: Math.min(1.4, Math.max(0.8, design.fontScale || 1)),
    lineHeight: rules.lineHeight,
  }
}

/** Fill in anything a stored design is missing, so an old device still prints. */
export function normaliseDesign(value: unknown): InvoiceDesign {
  const raw = (value ?? {}) as Partial<InvoiceDesign>
  const template: InvoiceTemplate =
    raw.template === 'compact' || raw.template === 'detailed' || raw.template === 'mushak'
      ? raw.template
      : 'standard'

  return {
    template,
    shopName: typeof raw.shopName === 'string' ? raw.shopName : DEFAULT_INVOICE_DESIGN.shopName,
    headerLines: typeof raw.headerLines === 'string' ? raw.headerLines : DEFAULT_INVOICE_DESIGN.headerLines,
    binNumber: typeof raw.binNumber === 'string' ? raw.binNumber : DEFAULT_INVOICE_DESIGN.binNumber,
    showCustomer: typeof raw.showCustomer === 'boolean' ? raw.showCustomer : DEFAULT_INVOICE_DESIGN.showCustomer,
    showCashier: typeof raw.showCashier === 'boolean' ? raw.showCashier : DEFAULT_INVOICE_DESIGN.showCashier,
    showItemNotes: typeof raw.showItemNotes === 'boolean' ? raw.showItemNotes : DEFAULT_INVOICE_DESIGN.showItemNotes,
    showUnitPrice: typeof raw.showUnitPrice === 'boolean' ? raw.showUnitPrice : DEFAULT_INVOICE_DESIGN.showUnitPrice,
    footerText: typeof raw.footerText === 'string' ? raw.footerText : DEFAULT_INVOICE_DESIGN.footerText,
    fontScale: typeof raw.fontScale === 'number' && Number.isFinite(raw.fontScale) ? raw.fontScale : 1,
  }
}
