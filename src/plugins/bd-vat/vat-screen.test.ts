/**
 * The Mushak switch.
 *
 * What must hold: the switch writes the same per-device design the printer
 * reads, turning it off falls back to the plain receipt, and the screen is
 * honest about a Mushak with no BIN — a form that calls itself a VAT
 * invoice without a registration number behind it is the one state this
 * plugin exists to prevent.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createVatScreen } from './vat-screen'
import { invoiceDesign, saveInvoiceDesign } from '../../shared/devices/device-config'
import { DEFAULT_INVOICE_DESIGN } from '../../shared/receipt/design'

const toggleBox = (root: HTMLElement): HTMLInputElement =>
  root.querySelector<HTMLInputElement>('input[type=checkbox]')!

const flip = (box: HTMLInputElement): void => {
  box.checked = !box.checked
  box.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
  saveInvoiceDesign({ ...DEFAULT_INVOICE_DESIGN })
})

describe('the Mushak switch', () => {
  it('turns the device onto the Mushak-6.3 template, and back to standard', () => {
    const root = createVatScreen({ shopName: 'Mekholi Store' })
    document.body.append(root)

    flip(toggleBox(root))
    expect(invoiceDesign().template).toBe('mushak')

    flip(toggleBox(root))
    // Back to the *simple* receipt, not whatever came before — switching
    // VAT invoicing off is a simple statement.
    expect(invoiceDesign().template).toBe('standard')
  })

  it('warns in the status card when Mushak is on with no BIN', () => {
    saveInvoiceDesign({ ...DEFAULT_INVOICE_DESIGN, template: 'mushak', binNumber: '' })
    const root = createVatScreen({ shopName: 'Mekholi Store' })

    expect(root.textContent).toContain('No BIN set')
    expect(root.textContent).toContain('not a VAT invoice')
  })

  it('saves the BIN into the shared invoice design', () => {
    const root = createVatScreen({ shopName: 'Mekholi Store' })
    const bin = root.querySelector<HTMLInputElement>('input[placeholder="0012345678-0101"]')!

    bin.value = ' 001234567890 '
    bin.dispatchEvent(new Event('change', { bubbles: true }))

    // Trimmed, and in the same store printer-setup edits — the two screens
    // can never disagree about what the printer prints.
    expect(invoiceDesign().binNumber).toBe('001234567890')
  })
})
