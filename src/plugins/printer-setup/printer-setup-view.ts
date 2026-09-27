/**
 * Printer setup.
 *
 * A POS without a printer is a calculator, and until now Mekholi's only answer
 * was the browser's print dialog — which on an Android tablet means "install a
 * driver", on a phone means nothing at all, and never once opened a cash
 * drawer. This screen is the missing half: pair the actual hardware, over
 * whichever of the three buses it happens to speak, and test it before a
 * customer is standing there.
 *
 * ── What the shopkeeper is choosing between ───────────────────────────────
 *   Bluetooth  The battery-powered 58mm units. Chrome/Edge on Android,
 *              Windows, macOS, Linux. Not iOS — no browser on iOS has it.
 *   USB        A desk printer on a PC. Same browsers.
 *   Network    A LAN printer on port 9100. Needs a bridge, because a browser
 *              cannot open a socket; the page says so plainly.
 *   Browser    The system print dialog. Works everywhere, drives nothing.
 *
 * The page is honest about capability up front rather than after a failed tap:
 * each option carries its own reason when the browser cannot do it.
 */

import { h, icon, mount } from '../../components/ui/h'
import { button } from '../../components/ui/button'
import { badge, card, cardHeader, emptyState } from '../../components/ui/card'
import { checkbox, field, input, select } from '../../components/ui/input'
import { confirm } from '../../components/feedback/modal'
import { toastError, toastSuccess, toastWarning } from '../../components/feedback/toast'
import {
  activePrinter,
  capabilities,
  invoiceDesign,
  loadDeviceSettings,
  newPrinter,
  saveDeviceSettings,
  type DeviceSettings,
  type PrinterConfig,
  type PrinterTransport,
} from '../../shared/devices/device-config'
import { pairBluetoothPrinter, pairUsbPrinter, sendToPrinter } from '../../shared/devices/printer-transport'
import { reportPrintFailure } from './report'
import { EscPosBuilder, columnsFor } from '../../shared/devices/escpos'
import { escPosJob, receiptPdf, receiptPng } from '../../shared/receipt/export'
import { sampleReceipt } from '../../shared/receipt/sample'
import { downloadBlob } from '../../shared/export/download'

const TRANSPORTS: Array<{ id: PrinterTransport; label: string; icon: string; blurb: string }> = [
  {
    id: 'bluetooth',
    label: 'Bluetooth',
    icon: 'bluetooth',
    blurb: 'Battery thermal printers. Pair once; the till reconnects each time it prints.',
  },
  {
    id: 'usb',
    label: 'USB',
    icon: 'usb',
    blurb: 'A desk printer plugged into this computer.',
  },
  {
    id: 'network',
    label: 'Wi-Fi / LAN',
    icon: 'wifi',
    blurb: 'A printer with its own IP address, reached through a print bridge on your network.',
  },
  {
    id: 'browser',
    label: 'System dialog',
    icon: 'print',
    blurb: 'No pairing. Opens the browser print dialog — works on any device, including iPads.',
  },
]

export interface PrinterSetupOptions {
  /**
   * The shop's name, for the test page and the sample receipt.
   *
   * Passed in rather than read from the session: a plugin may not import the
   * app layer (spec §51), and the host knows the organisation anyway. The
   * invoice design's own shop name wins over it when one is set, because
   * that is the name the paper actually carries.
   */
  shopName?: string
}

export function printerSetupView(options: PrinterSetupOptions = {}): HTMLElement {
  const orgName = options.shopName ?? 'Mekholi'
  const settings: DeviceSettings = loadDeviceSettings()
  const caps = capabilities()

  const root = h('div', { class: 'w-full min-w-0 p-3 sm:p-6' })
  const content = h('div', { class: 'w-full min-w-0 space-y-4' })
  root.append(content)

  function persist(): void {
    saveDeviceSettings(settings)
    render()
  }

  // ── Adding ──────────────────────────────────────────────────────────────

  async function addBluetooth(): Promise<void> {
    try {
      const paired = await pairBluetoothPrinter()
      settings.printers.push(
        newPrinter({ name: paired.deviceName, transport: 'bluetooth', bluetooth: paired })
      )
      settings.activePrinterId = settings.printers.at(-1)?.id ?? null
      persist()
      toastSuccess(`${paired.deviceName} paired.`)
    } catch (error) {
      reportPairFailure(error)
    }
  }

  async function addUsb(): Promise<void> {
    try {
      const paired = await pairUsbPrinter()
      settings.printers.push(
        newPrinter({
          name: paired.productName ?? `USB printer ${paired.vendorId.toString(16)}:${paired.productId.toString(16)}`,
          transport: 'usb',
          usb: paired,
        })
      )
      settings.activePrinterId = settings.printers.at(-1)?.id ?? null
      persist()
      toastSuccess('USB printer added.')
    } catch (error) {
      reportPairFailure(error)
    }
  }

  function addNetwork(): void {
    settings.printers.push(
      newPrinter({
        name: 'Network printer',
        transport: 'network',
        network: { host: '192.168.0.100', port: 9100, bridgeUrl: '' },
      })
    )
    settings.activePrinterId = settings.printers.at(-1)?.id ?? null
    persist()
  }

  function addBrowser(): void {
    settings.printers.push(newPrinter({ name: 'System print dialog', transport: 'browser', mode: 'raster' }))
    settings.activePrinterId = settings.printers.at(-1)?.id ?? null
    persist()
  }

  /**
   * A cancelled chooser is not an error.
   *
   * `requestDevice` rejects with `NotFoundError` both when the user closed the
   * dialog and when nothing was found, and a red toast for "I changed my mind"
   * trains people to ignore red toasts.
   */
  function reportPairFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (/cancel|user gesture|chooser|NotFoundError|No device selected/i.test(message)) {
      toastWarning('No printer was chosen.')
      return
    }
    toastError(message)
  }

  // ── Testing ─────────────────────────────────────────────────────────────

  async function testPrint(printer: PrinterConfig): Promise<void> {
    const shop = invoiceDesign().shopName.trim() || orgName
    try {
      if (printer.transport === 'browser') {
        window.print()
        return
      }
      // A test page, not a fake sale: a receipt the shop might mistake for a
      // real one is a receipt that ends up in the till drawer.
      const width = columnsFor(printer.paperWidth)
      const job = new EscPosBuilder()
        .init()
        .align('center')
        .size(2, 2)
        .bold(true)
        .line('TEST')
        .size(1, 1)
        .bold(false)
        .line(shop)
        .align('left')
        .rule(width)
        .line(`Printer : ${printer.name}`)
        .line(`Paper   : ${printer.paperWidth}mm · ${width} columns`)
        .line(`Mode    : ${printer.mode === 'raster' ? 'Image (Bangla safe)' : 'Text (ASCII only)'}`)
        .line(`Time    : ${new Date().toLocaleString('en-GB')}`)
        .rule(width)
        .columns('If this is readable', 'it works', width)

      if (printer.openDrawer) job.openDrawer()
      job.cut(true)

      await sendToPrinter(printer, job.build())
      toastSuccess('Test sent.')
    } catch (error) {
      reportPrintFailure(error, 'The test page could not be printed.')
    }
  }

  async function testReceipt(printer: PrinterConfig): Promise<void> {
    try {
      const data = sampleReceipt(invoiceDesign().shopName.trim() || orgName)
      await sendToPrinter(printer, escPosJob(data, printer))
      toastSuccess('Sample receipt sent.')
    } catch (error) {
      reportPrintFailure(error, 'The sample could not be printed.')
    }
  }

  async function previewFile(kind: 'png' | 'pdf'): Promise<void> {
    const printer = activePrinter(settings)
    const paper = printer?.paperWidth ?? 80
    const data = sampleReceipt(invoiceDesign().shopName.trim() || orgName)
    try {
      const blob = kind === 'png' ? await receiptPng(data, paper) : await receiptPdf(data, paper)
      const result = downloadBlob(`sample-receipt.${kind}`, blob)
      if (!result.ok) toastError(result.reason ?? 'The file could not be saved.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'The sample could not be produced.')
    }
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  function transportCard(): HTMLElement {
    const options = TRANSPORTS.map((transport) => {
      const capability =
        transport.id === 'bluetooth' ? caps.bluetooth : transport.id === 'usb' ? caps.usb : { supported: true, reason: '' }

      const add = button(capability.supported ? 'Add' : 'Unavailable', {
        size: 'sm',
        variant: capability.supported ? 'secondary' : 'ghost',
        disabled: !capability.supported,
        onClick: () => {
          if (transport.id === 'bluetooth') void addBluetooth()
          else if (transport.id === 'usb') void addUsb()
          else if (transport.id === 'network') addNetwork()
          else addBrowser()
        },
      })
      add.dataset.add = transport.id

      return h('div', {
        class: 'flex items-start gap-3 rounded-lg border border-border p-3',
      },
        icon(transport.icon, 'text-xl text-content-muted mt-0.5 shrink-0'),
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'text-sm font-medium text-content', text: transport.label }),
          h('p', { class: 'mt-0.5 text-xs text-content-muted', text: transport.blurb }),
          capability.supported
            ? null
            : h('p', { class: 'mt-1 text-xs text-warning', text: capability.reason })
        ),
        add
      )
    })

    return card(
      cardHeader('Add a printer', {
        iconName: 'add_circle',
        subtitle: 'Printers are remembered on this device only — each till pairs its own.',
      }),
      h('div', { class: 'grid gap-2 sm:grid-cols-2' }, ...options)
    )
  }

  function printerCard(printer: PrinterConfig): HTMLElement {
    const isActive = printer.id === settings.activePrinterId

    const update = (patch: Partial<PrinterConfig>): void => {
      Object.assign(printer, patch)
      persist()
    }

    const name = input({ value: printer.name })
    name.addEventListener('change', () => update({ name: name.value.trim() || printer.name }))

    const paper = select({
      value: String(printer.paperWidth),
      options: [
        { value: '80', label: '80mm — 48 columns' },
        { value: '58', label: '58mm — 32 columns' },
      ],
      onChange: (value) => update({ paperWidth: value === '58' ? 58 : 80 }),
    })

    const mode = select({
      value: printer.mode,
      options: [
        { value: 'raster', label: 'Image — prints Bangla and logos' },
        { value: 'text', label: 'Text — faster, English only' },
      ],
      onChange: (value) => update({ mode: value === 'text' ? 'text' : 'raster' }),
    })

    const copies = select({
      value: String(printer.copies),
      options: [1, 2, 3].map((n) => ({ value: String(n), label: n === 1 ? '1 copy' : `${n} copies` })),
      onChange: (value) => update({ copies: Number(value) || 1 }),
    })

    const network = printer.transport === 'network' ? printer.network : undefined
    const host = input({ value: network?.host ?? '', placeholder: '192.168.0.100' })
    const port = input({ value: String(network?.port ?? 9100), inputmode: 'numeric' })
    const bridge = input({ value: network?.bridgeUrl ?? '', placeholder: 'http://192.168.0.5:3131/print' })
    const saveNetwork = (): void =>
      update({
        network: {
          host: host.value.trim(),
          port: Number(port.value) || 9100,
          bridgeUrl: bridge.value.trim(),
        },
      })
    for (const box of [host, port, bridge]) box.addEventListener('change', saveNetwork)

    return card(
      cardHeader(printer.name, {
        iconName: printer.transport === 'bluetooth' ? 'bluetooth' : printer.transport === 'usb' ? 'usb' : printer.transport === 'network' ? 'wifi' : 'print',
        subtitle: describeConnection(printer),
        actions: [
          isActive
            ? badge('Default', { tone: 'success' })
            : button('Make default', {
                size: 'sm',
                variant: 'ghost',
                onClick: () => {
                  settings.activePrinterId = printer.id
                  persist()
                },
              }),
        ],
      }),

      h('div', { class: 'grid gap-3 sm:grid-cols-2' },
        field('Name', name),
        field('Paper', paper),
        field('Printing mode', mode, {
          hint:
            printer.mode === 'text'
              ? 'Bangla cannot be printed in text mode — the printer has no Bangla glyphs. A receipt containing any is sent as an image anyway.'
              : 'The receipt is sent as a picture, so Bangla, logos and QR codes all print.',
        }),
        field('Copies', copies)
      ),

      ...(printer.transport === 'network'
        ? [
            h('div', { class: 'mt-3 rounded-lg border border-border bg-surface-muted p-3' },
              h('p', { class: 'text-xs text-content-muted' },
                h('span', { class: 'font-medium text-content', text: 'Why a bridge is needed. ' }),
                h('span', {
                  text:
                    'A web page cannot open a printer socket — no browser allows it. Run the Mekholi print bridge on any always-on machine on the shop network (a PC, a Raspberry Pi, the Android wrapper) and point this at it. The bridge opens port 9100 for you.',
                })
              ),
              h('p', { class: 'mt-2 font-mono text-[11px] text-content-muted' },
                h('span', { text: 'node tools/print-bridge.mjs' })
              ),
              h('p', { class: 'mt-1 text-xs text-content-subtle' },
                h('span', {
                  text: 'It needs nothing installed beyond Node, prints a line per job, and answers on http://<that machine>:3131/print.',
                })
              ),
              h('div', { class: 'mt-3 grid gap-3 sm:grid-cols-3' },
                field('Printer IP', host),
                field('Port', port),
                field('Bridge URL', bridge)
              )
            ),
          ]
        : []),

      h('div', { class: 'mt-3 flex flex-wrap items-center gap-3' },
        checkbox({
          checked: printer.cut,
          label: 'Cut the paper',
          onChange: (value) => update({ cut: value }),
        }),
        checkbox({
          checked: printer.openDrawer,
          label: 'Kick the cash drawer',
          onChange: (value) => update({ openDrawer: value }),
        }),
        checkbox({
          checked: printer.autoPrint,
          label: 'Print automatically when a sale completes',
          onChange: (value) => update({ autoPrint: value }),
        })
      ),

      h('div', { class: 'mt-3 flex flex-wrap gap-2 border-t border-border pt-3' },
        button('Test page', {
          size: 'sm',
          variant: 'secondary',
          icon: 'print',
          onClick: () => void testPrint(printer),
        }),
        button('Sample receipt', {
          size: 'sm',
          variant: 'ghost',
          icon: 'receipt_long',
          onClick: () => void testReceipt(printer),
        }),
        button('Remove', {
          size: 'sm',
          variant: 'ghost',
          icon: 'delete',
          class: 'text-danger',
          onClick: () => void remove(printer),
        })
      )
    )
  }

  async function remove(printer: PrinterConfig): Promise<void> {
    const ok = await confirm(`Remove ${printer.name}?`, {
      message: 'The pairing stays in the browser; only this till forgets the printer.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    settings.printers = settings.printers.filter((row) => row.id !== printer.id)
    if (settings.activePrinterId === printer.id) settings.activePrinterId = settings.printers[0]?.id ?? null
    persist()
  }

  function filesCard(): HTMLElement {
    return card(
      cardHeader('Receipt files', {
        iconName: 'download',
        subtitle: 'What the cashier can save or send when there is no printer at all.',
      }),
      h('p', { class: 'text-xs text-content-muted' , text:
        'Every completed sale offers these two downloads as well as printing. The image is the same picture the thermal printer receives, so what is saved is what would have been on the paper.' }),
      h('div', { class: 'mt-3 flex flex-wrap gap-2' },
        button('Sample image (PNG)', { size: 'sm', variant: 'secondary', icon: 'image', onClick: () => void previewFile('png') }),
        button('Sample PDF', { size: 'sm', variant: 'secondary', icon: 'picture_as_pdf', onClick: () => void previewFile('pdf') })
      )
    )
  }

  function render(): void {
    mount(
      content,
      h('div', { class: 'flex items-start justify-between gap-3' },
        h('div', {},
          h('h1', { class: 'text-lg font-semibold text-content', text: 'Printer setup' }),
          h('p', { class: 'text-sm text-content-muted', text: 'Connect the till to the paper.' })
        ),
        settings.printers.length > 0
          ? badge(`${settings.printers.length} configured`)
          : null
      ),

      transportCard(),

      settings.printers.length === 0
        ? card(
            emptyState('No printer on this till yet', {
              description:
                'Add one above. If this device cannot pair — an iPad, for instance — the system print dialog and the PDF download both still work.',
              iconName: 'print_disabled',
            })
          )
        : h('div', { class: 'space-y-4' }, ...settings.printers.map(printerCard)),

      filesCard()
    )
  }

  render()
  return root
}

function describeConnection(printer: PrinterConfig): string {
  switch (printer.transport) {
    case 'bluetooth':
      return `Bluetooth · ${printer.bluetooth?.deviceName ?? 'paired device'}`
    case 'usb':
      return `USB · ${printer.usb?.productName ?? `${printer.usb?.vendorId.toString(16)}:${printer.usb?.productId.toString(16)}`}`
    case 'network':
      return printer.network?.bridgeUrl
        ? `Network · ${printer.network.host}:${printer.network.port}`
        : 'Network · bridge address missing'
    case 'browser':
      return 'The browser’s own print dialog'
  }
}
