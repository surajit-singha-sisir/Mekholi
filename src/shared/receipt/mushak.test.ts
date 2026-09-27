/**
 * The Mushak-6.3 template (docs/17 Tier 1 #3).
 *
 * What makes a till slip a VAT invoice is checkable: the form names itself,
 * the seller's BIN is on it, and the VAT amount is stated even when it is
 * zero — on a tax document an absent line reads as an omission, where ৳0.00
 * is an answer.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { renderReceipt } from './receipt'
import { sampleReceipt } from './sample'
import {
  DEFAULT_INVOICE_DESIGN,
  INVOICE_TEMPLATES,
  normaliseDesign,
  resolveDesign,
  type InvoiceDesign,
} from './design'

const textOf = (node: HTMLElement): string => (node.textContent ?? '').replace(/\s+/g, ' ')

function design(overrides: Partial<InvoiceDesign> = {}): InvoiceDesign {
  return { ...DEFAULT_INVOICE_DESIGN, ...overrides }
}

describe('the Mushak-6.3 template', () => {
  it('is offered in the template list', () => {
    expect(INVOICE_TEMPLATES.map((template) => template.value)).toContain('mushak')
  })

  it('survives a round trip through a stored design', () => {
    const stored = normaliseDesign({ template: 'mushak', binNumber: '0012345678901' })
    expect(stored.template).toBe('mushak')
    expect(stored.binNumber).toBe('0012345678901')
  })

  it('an old stored design without a BIN still normalises', () => {
    expect(normaliseDesign({ template: 'standard' }).binNumber).toBe('')
  })

  it('names the form and prints the BIN', () => {
    const slip = textOf(
      renderReceipt(sampleReceipt(), design({ template: 'mushak', binNumber: '0012345678901' }))
    )
    expect(slip).toContain('Mushak-6.3')
    expect(slip).toContain('মূসক-৬.৩')
    expect(slip).toContain('BIN: 0012345678901')
  })

  it('states the VAT even when it is zero, and totals include it', () => {
    const data = { ...sampleReceipt(), tax: '৳0.00' }
    const slip = textOf(renderReceipt(data, design({ template: 'mushak' })))
    expect(slip).toContain('VAT')
    expect(slip).toContain('TOTAL (incl. VAT)')
  })

  it('a standard slip with a BIN prints it too — one registration, every slip', () => {
    const slip = textOf(
      renderReceipt(sampleReceipt(), design({ template: 'standard', binNumber: '999' }))
    )
    expect(slip).toContain('BIN: 999')
    expect(slip).not.toContain('Mushak-6.3')
  })

  it('the compact template prints no header, so no BIN either', () => {
    const resolved = resolveDesign(design({ template: 'compact', binNumber: '999' }))
    expect(resolved.binNumber).toBe('')
  })

  it('a zero tax on a non-Mushak slip stays unprinted, as before', () => {
    const data = { ...sampleReceipt(), tax: '৳0.00' }
    const slip = textOf(renderReceipt(data, design({ template: 'standard' })))
    expect(slip).not.toContain('VAT')
    expect(slip).toContain('TOTAL')
    expect(slip).not.toContain('incl. VAT')
  })
})
