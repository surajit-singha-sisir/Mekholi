/**
 * Receipts (spec §54).
 *
 * Two halves, deliberately separated. `buildReceipt` turns a sale row into a
 * plain data structure — no DOM, no formatting — and `renderReceipt` turns
 * that into an 80mm layout. The split matters because the data model is what
 * an Android client, an email sender and a fiscal-reporting integration all
 * need, while the 80mm template is one of several possible renderings.
 *
 * 80mm thermal stock is 72mm printable inside the margins. At 96dpi that is
 * about 272px, so the layout is fixed to that width rather than made
 * responsive: a receipt that reflows is a receipt that does not fit the paper.
 */

import { h } from '../../components/ui/h'
import { activePrinter, invoiceDesign } from '../../shared/devices/device-config'
import { sendToPrinter } from '../../shared/devices/printer-transport'
import { reportPrintFailure } from '../devices'
import { downloadBlob } from '../../shared/export/download'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { escPosJob, receiptPdf, receiptPng } from '../../shared/receipt/export'
import {
  buildReceipt,
  receiptCss,
  renderReceipt,
  type ReceiptData,
} from '../../shared/receipt/receipt'
import type { SaleRow } from '../../shared/types/records'

// Re-exported so the rest of the app still has one place to ask for a
// receipt, even though the engine now lives in `shared/` where a plugin can
// reach it too.
export { buildReceipt, renderReceipt, type ReceiptData, type ReceiptLine } from '../../shared/receipt/receipt'

// ── Receipt actions, independent of the dialog ────────────────────────────
//
// Printing a receipt and saving it as a file are not things only the till
// does. Sales history reprints months-old invoices, and a customer asking for
// "the PDF" is asking for the same bytes the printer was given. Both live here
// as plain functions over `ReceiptData` so that every screen produces an
// identical document — a reprint that disagreed with the original paper would
// be worse than no reprint at all.

/** Save the receipt as a PNG or a PDF, at the active printer's paper width. */
export async function saveReceiptFile(data: ReceiptData, kind: 'png' | 'pdf'): Promise<void> {
  const paper = activePrinter()?.paperWidth ?? 80
  const design = invoiceDesign()
  try {
    const blob = kind === 'png' ? await receiptPng(data, paper, design) : await receiptPdf(data, paper, design)
    const result = downloadBlob(`${data.invoiceNo}.${kind}`, blob)
    if (!result.ok) toastError(result.reason ?? 'The file could not be saved.')
  } catch (error) {
    toastError(error instanceof Error ? error.message : 'The file could not be created.')
  }
}

/**
 * Send the receipt to whatever this shop prints with.
 *
 * With a configured thermal printer that means raw ESC/POS; with none it means
 * the browser's own dialog, which every machine has. A printer that was never
 * finished being set up gets the setup page offered rather than a socket
 * error, and nothing here throws: printing is never the last step that can
 * fail, because the sale is already banked by the time anyone prints it.
 */
export async function printReceipt(data: ReceiptData): Promise<void> {
  const printer = activePrinter()
  if (!printer || printer.transport === 'browser') {
    window.print()
    return
  }
  try {
    await sendToPrinter(printer, escPosJob(data, printer, invoiceDesign()))
    toastSuccess('Printing.')
  } catch (error) {
    reportPrintFailure(error, 'The printer did not answer.')
  }
}

/**
 * Show the receipt and offer to print it.
 *
 * Rendered into a dedicated root that the print stylesheet isolates, so
 * printing produces the receipt alone rather than the POS screen with a
 * receipt floating over it.
 */
export function openReceipt(
  sale: SaleRow,
  currency: string,
  shopName = 'Mekholi',
  notes: ReadonlyMap<string, readonly string[]> = new Map()
): { close: () => void } {
  void currency
  return showReceipt(buildReceipt(sale, shopName, notes))
}

/**
 * The same dialog, for a receipt that has already been built.
 *
 * Sales history has a `SaleDetail` and its own reasons to preview an invoice;
 * it should not have to reconstruct a `SaleRow` to borrow this screen.
 */
export function showReceipt(data: ReceiptData): { close: () => void } {
  const printer = activePrinter()

  const overlay = h('div', {
    id: 'mekholi-print-root',
    // Above the modal layer (z-[90]) and the command palette (z-[95]): the
    // receipt is opened *from* the sale-detail modal, so it must sit on top of
    // it, not slide behind it. Matches the top overlay tier (toasts, splash).
    class: 'fixed inset-0 z-[100] overflow-y-auto bg-content/40 p-4',
    style: { backdropFilter: 'blur(2px)' },
  })

  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  /**
   * What the cashier can do with a finished sale.
   *
   * Four routes off one receipt, because a shop counter is not one setup:
   * the thermal printer when there is one, the system dialog when there is
   * not, and two files for the customer who says "send it to me". The files
   * are the same picture the printer is given, so nothing the customer keeps
   * disagrees with what came out of the machine.
   */
  const actionButton = (label: string, primary: boolean, onClick: () => void): HTMLElement =>
    h('button', {
      type: 'button',
      class: primary
        ? 'flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium'
        : 'flex-1 h-9 rounded-md border border-border bg-surface text-content text-sm font-medium',
      text: label,
      onclick: onClick,
    })

  const saveFile = (kind: 'png' | 'pdf'): Promise<void> => saveReceiptFile(data, kind)
  const printNow = (): Promise<void> => printReceipt(data)

  const actions = h(
    'div',
    { class: 'mekholi-receipt-actions mx-auto mb-3 flex max-w-[272px] flex-wrap gap-2' },
    actionButton(printer && printer.transport !== 'browser' ? `Print · ${printer.name}` : 'Print', true, () => void printNow()),
    actionButton('Image', false, () => void saveFile('png')),
    actionButton('PDF', false, () => void saveFile('pdf')),
    actionButton('Close', false, () => close())
  )

  overlay.append(h('style', { text: receiptCss(invoiceDesign()) }), actions, renderReceipt(data, invoiceDesign()))
  document.body.appendChild(overlay)

  // "Print automatically when a sale completes" (Printer setup). The dialog
  // still opens: the cashier needs somewhere to reprint from when the paper
  // jams, and a silent auto-print that failed would leave no trace on screen.
  if (printer?.autoPrint && printer.transport !== 'browser') void printNow()

  return { close }
}

