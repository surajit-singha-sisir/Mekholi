/**
 * The currency screen: status, the picker, the rate, and the honesty card.
 *
 * Order matters, as ever. The status card answers the only question the
 * shopkeeper brings — "what will my numbers read as?" — with the example
 * everyone reasons in: what ৳1,400 becomes. The controls come second. The
 * honesty card comes last and is the most important text on the page: it
 * says out loud that the books never leave the base currency, so nobody
 * discovers that by surprise during an audit.
 *
 * Saving is immediate, like the VAT screen: a settings page with a save
 * button is a settings page that gets closed unsaved.
 */

import { h, mount } from '../../components/ui/h'
import { badge, card, cardHeader } from '../../components/ui/card'
import { field, input, select } from '../../components/ui/input'
import { button } from '../../components/ui/button'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import {
  convertToDisplayMinor,
  formatMoney,
  minor,
  westernDigits,
  type DisplayConversion,
} from '../../shared/domain/money'
import { currencyLabel, currencyOptions, findCurrency } from '../../shared/domain/currencies'
import { isStale, resolveConversion, type MultiCurrencyConfig } from './engine'
import type { CurrencyScreenHost } from './index'

/** The amount every explanation on this screen converts, per the shop's ask. */
const SAMPLE_BASE_MINOR = minor(1400 * 100)

export function createCurrencyScreen(host: CurrencyScreenHost): HTMLElement {
  const base = host.base.trim().toUpperCase() || 'BDT'
  let config = normalise(host.config(), base)

  const root = h('div', { class: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-4' })
  const statusSlot = h('div', {})

  // ── Status ────────────────────────────────────────────────────────────
  function drawStatus(): void {
    const conversion = resolveConversion(config, base)
    const children: (HTMLElement | null)[] = []

    if (!config.target) {
      children.push(badge(`Showing ${base} — no conversion`, { tone: 'neutral', iconName: 'visibility' }))
    } else if (conversion) {
      children.push(
        badge(`${base} ➜ ${conversion.code}`, { tone: 'success', iconName: 'currency_exchange' }),
        badge(rateSentence(conversion, base), { tone: 'neutral', iconName: 'percent' }),
        h('p', {
          class: 'w-full text-sm tabular-nums text-content',
          text: `${formatMoney(SAMPLE_BASE_MINOR, { currency: base, convert: false })} now reads as ${formatTarget(conversion)}.`,
        }),
        h('p', { class: 'w-full text-xs text-content-subtle', text: sourceSentence(config) })
      )
    } else {
      children.push(
        badge(`${base} ➜ ${config.target} — waiting for a rate`, { tone: 'warning', iconName: 'hourglass_empty' }),
        h('p', {
          class: 'w-full text-xs text-danger',
          text:
            config.mode === 'manual'
              ? 'Type your rate below — until then nothing converts.'
              : 'No live rate cached yet. Press “Fetch the live rate now”, or switch to a manual rate.',
        })
      )
    }

    mount(
      statusSlot,
      card(
        cardHeader('What the shop reads', {
          subtitle: 'Every amount on screen, on reports and on receipts follows this',
        }),
        h('div', { class: 'flex flex-wrap items-center gap-2' }, ...children)
      )
    )
  }

  function persist(message?: string): void {
    // Redraw first: the screen answers the eye now, the config bag catches
    // up a beat later. The provider is pushed inside `host.save`.
    void host.save(config).then(() => {
      if (message) toastSuccess(message)
    })
    drawStatus()
  }

  // ── Target picker ─────────────────────────────────────────────────────
  const targetSelect = select({
    value: config.target,
    options: [
      { value: '', label: `Off — show ${base}, the shop's own currency` },
      ...currencyOptions(config.target || null).filter((option) => option.value !== base),
    ],
    onChange: (value) => {
      config = { ...config, target: value.trim().toUpperCase(), base }
      const name = findCurrency(config.target)
      persist(
        config.target
          ? `Now showing ${name ? name.name : config.target}. The books stay in ${base}.`
          : `Back to ${base} everywhere.`
      )
    },
  })

  // ── Rate source ───────────────────────────────────────────────────────
  const modeSelect = select({
    value: config.mode,
    options: [
      { value: 'live', label: 'Live rate — fetched when online, cached for when not' },
      { value: 'manual', label: 'My own rate — I type it, it never changes itself' },
    ],
    onChange: (value) => {
      config = { ...config, mode: value === 'manual' ? 'manual' : 'live', base }
      persist()
    },
  })

  const rateBox = input({
    value: config.manualRate > 0 ? String(config.manualRate) : '',
    placeholder: '122.50',
  })
  rateBox.inputMode = 'decimal'
  rateBox.addEventListener('change', () => {
    const cleaned = westernDigits(rateBox.value).replace(/[^0-9.]/g, '')
    const value = Number.parseFloat(cleaned)
    if (!Number.isFinite(value) || value <= 0) {
      config = { ...config, manualRate: 0, base }
      persist()
      if (rateBox.value.trim() !== '') toastError('A rate has to be a number above zero.')
      return
    }
    config = { ...config, manualRate: value, mode: 'manual', base }
    modeSelect.value = 'manual'
    persist(`Saved: 1 ${config.target || 'unit'} = ${value} ${base}.`)
  })

  const refreshButton = button('Fetch the live rate now', { icon: 'refresh' })
  refreshButton.addEventListener('click', () => {
    refreshButton.disabled = true
    void (async () => {
      try {
        const table = await host.refresh()
        if (!table) {
          toastError('Could not reach the exchange-rate feed. The cached rate, if any, still applies.')
          return
        }
        config = { ...config, table, base }
        persist('Live rates updated.')
      } finally {
        refreshButton.disabled = false
      }
    })()
  })

  const controlsCard = card(
    cardHeader('Display currency', { subtitle: `The shop's base currency is ${baseLabel(base)}` }),
    h(
      'div',
      { class: 'flex flex-col gap-4' },
      field('Show every amount in', targetSelect, {
        hint: 'Purely how amounts are displayed — nothing in the database is rewritten.',
      }),
      field('Where the rate comes from', modeSelect),
      field(`One ${config.target || 'unit of the display currency'} equals how many ${base}?`, rateBox, {
        hint: 'Used when the source above is your own rate. Example: 1 USD = 122.50 BDT.',
      }),
      h('div', { class: 'flex items-center gap-3' }, refreshButton)
    )
  )

  // ── The honesty card ──────────────────────────────────────────────────
  const honestyCard = card(
    cardHeader('What this does — and deliberately does not', {}),
    h(
      'ul',
      { class: 'flex list-disc flex-col gap-2 pl-5 text-sm text-content' },
      h('li', {
        text: `Converts what you see: the dashboard, product prices, the till, dues, reports and printed receipts all read in the display currency.`,
      }),
      h('li', {
        text: `Never converts what is stored: every sale, price and due stays in ${base} in the books. Turn this off — or fix a wrong rate — and nothing was lost.`,
      }),
      h('li', {
        text: `Amounts you type are still ${base}: a price field or a cash tender is entered in the shop's own currency, because that is what the drawer holds.`,
      }),
      h('li', {
        text: 'The live rate is cached on this shop, so a device that goes offline keeps converting on the last rate it saw.',
      })
    )
  )

  root.append(statusSlot, controlsCard, honestyCard)
  drawStatus()
  return root
}

// ── Small sentences ──────────────────────────────────────────────────────

function normalise(config: MultiCurrencyConfig, base: string): MultiCurrencyConfig {
  // A stored target equal to the (possibly changed) base is a no-op; showing
  // it as "on" would claim a conversion that cannot happen.
  return config.target === base ? { ...config, target: '' } : { ...config, base: config.base || base }
}

function baseLabel(base: string): string {
  const entry = findCurrency(base)
  return entry ? currencyLabel(entry) : base
}

function rateSentence(conversion: DisplayConversion, base: string): string {
  const rate = conversion.rate
  const rounded = rate >= 100 ? rate.toFixed(2) : rate.toPrecision(4)
  return `1 ${conversion.code} = ${Number(rounded)} ${base}`
}

function formatTarget(conversion: DisplayConversion): string {
  const entry = findCurrency(conversion.code)
  const scale = 10 ** conversion.decimals
  const amount = convertToDisplayMinor(SAMPLE_BASE_MINOR, conversion) / scale
  const symbol = entry ? entry.symbol : conversion.code
  return `${symbol}${amount.toFixed(conversion.decimals)}`
}

function sourceSentence(config: MultiCurrencyConfig): string {
  if (config.mode === 'manual') return 'Rate source: set by hand. It will not move until you move it.'
  if (!config.table) return 'Rate source: live feed.'
  const age = Date.now() - Date.parse(config.table.fetchedAt)
  const hours = Math.max(0, Math.floor(age / 3_600_000))
  const when = hours < 1 ? 'under an hour ago' : hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `${Math.floor(hours / 24)} days ago`
  return `Rate source: live feed, fetched ${when}${isStale(config.table) ? ' — stale, will refresh when online' : ''}.`
}
