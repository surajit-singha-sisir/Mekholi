/**
 * Barcode scanner setup.
 *
 * There is nothing to *install* — a wedge scanner is a keyboard as far as the
 * browser is concerned — so this page does the two things that actually help:
 * it proves the scanner works, and it measures it.
 *
 * ── Why measuring matters ─────────────────────────────────────────────────
 * The till tells a scan from typing by how fast the characters arrive. Get
 * that threshold wrong in one direction and a fast cashier's typing is
 * swallowed as a barcode; wrong in the other and every third scan is ignored.
 * The right number depends on the scanner, the cable, the USB polling rate and
 * the tablet — which is to say it cannot be guessed from here. So the shop
 * scans a product, the page reports what it saw, and offers the threshold that
 * fits *their* hardware with headroom.
 *
 * The page also names the two failures that generate most support calls: a
 * scanner that sends no Enter (so the code never commits) and one in the wrong
 * keyboard layout (so digits arrive as symbols).
 */

import { h, icon, mount } from '../../components/ui/h'
import { button } from '../../components/ui/button'
import { badge, card, cardHeader } from '../../components/ui/card'
import { checkbox, field, input, select } from '../../components/ui/input'
import { toastSuccess } from '../../components/feedback/toast'
import {
  DEFAULT_SCANNER,
  loadDeviceSettings,
  saveDeviceSettings,
  type DeviceSettings,
  type ScannerConfig,
} from '../../shared/devices/device-config'
import { beep, listenForScans, suggestGap, type ScanEvent } from '../../shared/devices/scanner'

interface Attempt {
  ok: boolean
  code: string
  averageGapMs: number
  durationMs: number
  keys: number
  reason?: string | undefined
}

export function scannerSetupView(): HTMLElement {
  let settings: DeviceSettings = loadDeviceSettings()
  let attempts: Attempt[] = []
  let stop: (() => void) | null = null

  const root = h('div', { class: 'w-full min-w-0 p-3 sm:p-6' })
  const content = h('div', { class: 'w-full min-w-0 space-y-4' })
  root.append(content)

  const testField = input({ placeholder: 'Click here, then scan a product…', autocomplete: 'off' })
  testField.dataset.role = 'scan-target'

  function persist(patch: Partial<ScannerConfig>): void {
    settings = { ...settings, scanner: { ...settings.scanner, ...patch } }
    saveDeviceSettings(settings)
    restartListener()
    render()
  }

  function record(attempt: Attempt): void {
    // Newest first, and only the last five: this is a diagnostic, not a log.
    attempts = [attempt, ...attempts].slice(0, 5)
    render()
  }

  function restartListener(): void {
    stop?.()
    stop = listenForScans({
      ...settings.scanner,
      // The test box must see everything, including the bursts the live till
      // would reject — that rejection is the diagnosis.
      minLength: 1,
      maxKeyGapMs: 1000,
      onScan: (event: ScanEvent) => {
        const tooSlow = event.averageGapMs > settings.scanner.maxKeyGapMs
        const tooShort = event.code.length < settings.scanner.minLength
        const ok = !tooSlow && !tooShort
        if (ok && settings.scanner.beep) beep(true)
        record({
          ok,
          code: event.code,
          averageGapMs: event.averageGapMs,
          durationMs: event.durationMs,
          keys: event.keys,
          reason: tooShort
            ? `Only ${event.code.length} characters — the till ignores anything under ${settings.scanner.minLength}.`
            : tooSlow
              ? `${Math.round(event.averageGapMs)} ms between keys — the till treats anything over ${settings.scanner.maxKeyGapMs} ms as typing.`
              : undefined,
        })
        testField.value = event.code
      },
    })
  }

  // ── Cards ───────────────────────────────────────────────────────────────

  function testCard(): HTMLElement {
    const good = attempts.filter((a) => a.ok)
    const suggestion = suggestGap(good.map((a) => a.averageGapMs))

    return card(
      cardHeader('Test the scanner', {
        iconName: 'qr_code_scanner',
        subtitle: 'Scan any barcode. Nothing is saved and no product is looked up.',
      }),
      testField,
      attempts.length === 0
        ? h('p', {
            class: 'mt-3 text-xs text-content-muted',
            text: 'Waiting for a scan. The box does not need to be focused — the till listens to the whole screen, which is the point.',
          })
        : h('div', { class: 'mt-3 space-y-2' },
            ...attempts.map((attempt) =>
              h('div', {
                class: [
                  'flex items-start gap-2 rounded-lg border p-2.5',
                  attempt.ok ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5',
                ].join(' '),
                'data-attempt': attempt.ok ? 'ok' : 'rejected',
              },
                icon(attempt.ok ? 'check_circle' : 'error', `text-lg shrink-0 ${attempt.ok ? 'text-success' : 'text-warning'}`),
                h('div', { class: 'min-w-0 flex-1' },
                  h('p', { class: 'truncate font-mono text-sm text-content', text: attempt.code || '(nothing)' }),
                  h('p', {
                    class: 'mt-0.5 text-xs text-content-muted',
                    text: `${attempt.keys} characters · ${Math.round(attempt.averageGapMs)} ms between keys · ${Math.round(attempt.durationMs)} ms total`,
                  }),
                  attempt.reason ? h('p', { class: 'mt-0.5 text-xs text-warning', text: attempt.reason }) : null
                )
              )
            )
          ),

      good.length > 0 && suggestion !== settings.scanner.maxKeyGapMs
        ? h('div', { class: 'mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted p-3' },
            h('p', { class: 'min-w-0 flex-1 text-xs text-content-muted',
              text: `This scanner sends a key every ${Math.round(Math.max(...good.map((a) => a.averageGapMs)))} ms at its slowest. ${suggestion} ms would fit it with room to spare.` }),
            button(`Use ${suggestion} ms`, {
              size: 'sm',
              variant: 'secondary',
              onClick: () => {
                persist({ maxKeyGapMs: suggestion })
                toastSuccess(`Threshold set to ${suggestion} ms.`)
              },
            })
          )
        : null
    )
  }

  function settingsCard(): HTMLElement {
    const scanner = settings.scanner

    const mode = select({
      value: scanner.mode,
      options: [
        { value: 'wedge', label: 'Keyboard wedge — the scanner types (almost all of them)' },
        { value: 'serial', label: 'Serial — the scanner streams over USB/Bluetooth serial' },
      ],
      onChange: (value) => persist({ mode: value === 'serial' ? 'serial' : 'wedge' }),
    })

    const suffix = select({
      value: scanner.suffix,
      options: [
        { value: 'enter', label: 'Enter (the usual factory setting)' },
        { value: 'tab', label: 'Tab' },
        { value: 'none', label: 'Nothing — the till settles on the pause instead' },
      ],
      onChange: (value) => persist({ suffix: value === 'tab' ? 'tab' : value === 'none' ? 'none' : 'enter' }),
    })

    const gap = input({ value: String(scanner.maxKeyGapMs), inputmode: 'numeric' })
    gap.addEventListener('change', () => persist({ maxKeyGapMs: clamp(Number(gap.value), 5, 500, DEFAULT_SCANNER.maxKeyGapMs) }))

    const minLength = input({ value: String(scanner.minLength), inputmode: 'numeric' })
    minLength.addEventListener('change', () => persist({ minLength: clamp(Number(minLength.value), 1, 32, DEFAULT_SCANNER.minLength) }))

    const prefix = input({ value: scanner.prefix, placeholder: 'none' })
    prefix.addEventListener('change', () => persist({ prefix: prefix.value }))

    return card(
      cardHeader('How the till reads it', { iconName: 'tune' }),
      h('div', { class: 'grid gap-3 sm:grid-cols-2' },
        field('Scanner type', mode),
        field('Sends after the code', suffix, {
          hint: 'If scans never commit, the scanner is not sending Enter. Its manual has a barcode to turn that on.',
        }),
        field('Fastest human typing (ms)', gap, {
          hint: 'Gaps below this mean a machine. Measure it above rather than guessing.',
        }),
        field('Shortest barcode', minLength, {
          hint: 'Shorter reads are treated as typing. EAN-8 is 8 digits; most retail codes are 12 or 13.',
        }),
        field('Prefix to strip', prefix, {
          hint: 'Some scanners prepend a character to mark a scan. Put it here and the till removes it.',
        })
      ),
      h('div', { class: 'mt-3' },
        checkbox({
          checked: scanner.beep,
          label: 'Beep when the till accepts a scan',
          onChange: (value) => persist({ beep: value }),
        })
      ),
      scanner.mode === 'serial'
        ? h('p', { class: 'mt-3 text-xs text-warning',
            text: 'Serial mode needs Web Serial — Chrome or Edge on a computer. Most shops should leave this on keyboard wedge.' })
        : null
    )
  }

  function troubleCard(): HTMLElement {
    const rows: Array<[string, string]> = [
      ['Nothing happens when I scan', 'The scanner is not sending Enter, or it is in a mode that needs its own software. Scan the “USB HID keyboard” and “Add Enter suffix” barcodes from its manual.'],
      ['Digits come out as symbols', 'The scanner is set to a different keyboard layout from the tablet. Set both to US English — this is the single most common cause.'],
      ['Every scan is rejected as typing', 'Raise the threshold above. A Bluetooth scanner on a busy link can be slower than a cabled one.'],
      ['The code is right but nothing is found', 'The barcode is not on any product yet. Open the product and add it — Products → the product → Barcodes.'],
      ['It scans into the wrong box', 'It will not once this page is set up: the till listens for scans across the whole screen, not only in the search field.'],
    ]

    return card(
      cardHeader('When it will not work', { iconName: 'help' }),
      h('div', { class: 'space-y-2' },
        ...rows.map(([symptom, cause]) =>
          h('div', { class: 'rounded-lg border border-border p-2.5' },
            h('p', { class: 'text-sm font-medium text-content', text: symptom }),
            h('p', { class: 'mt-0.5 text-xs text-content-muted', text: cause })
          )
        )
      )
    )
  }

  function render(): void {
    mount(
      content,
      h('div', { class: 'flex items-start justify-between gap-3' },
        h('div', {},
          h('h1', { class: 'text-lg font-semibold text-content', text: 'Barcode scanner setup' }),
          h('p', { class: 'text-sm text-content-muted', text: 'Prove it works, then tune it to this shop’s hardware.' })
        ),
        badge(settings.scanner.mode === 'wedge' ? 'Keyboard wedge' : 'Serial', {
          tone: 'neutral',
          iconName: 'barcode_scanner',
        })
      ),
      testCard(),
      settingsCard(),
      troubleCard()
    )
  }

  restartListener()
  render()

  // The listener is global, so it has to go when the screen does. A router
  // that swaps the view without telling us would otherwise leave one running
  // per visit, each writing into a detached input.
  const observer = new MutationObserver(() => {
    if (!root.isConnected) {
      stop?.()
      stop = null
      observer.disconnect()
    }
  })
  if (typeof document !== 'undefined') {
    observer.observe(document.body, { childList: true, subtree: true })
  }

  return root
}

function clamp(value: number, low: number, high: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(high, Math.max(low, Math.round(value)))
}
