/**
 * The notifications settings screen: which of the shop's watchers may ring.
 *
 * One card per watcher, a switch on each, and the due watcher carries its
 * floor — the amount below which baki is a neighbourly arrangement, not
 * an alert. Saving is immediate, like every plugin settings screen here:
 * a page with a save button is a page that gets closed unsaved.
 */

import { h } from '../../components/ui/h'
import { card, cardHeader } from '../../components/ui/card'
import { field, input } from '../../components/ui/input'
import { toastSuccess } from '../../components/feedback/toast'
import { formatMoney, minor, parseMinor } from '../../shared/domain/money'
import { DEFAULT_PREFS, type NotificationPrefs } from './engine'

export interface SettingsScreenHost {
  /** The shop's base currency, straight from the page context. */
  currency: string
  prefs(): NotificationPrefs
  save(prefs: NotificationPrefs): Promise<void>
}

interface Watcher {
  key: 'stock' | 'dues' | 'summary' | 'warranty' | 'transfers'
  icon: string
  title: string
  subtitle: string
}

const WATCHERS: Watcher[] = [
  {
    key: 'stock',
    icon: 'inventory_2',
    title: 'Stock running out',
    subtitle: 'Rings when a tracked product hits zero, or falls to its reorder point.',
  },
  {
    key: 'transfers',
    icon: 'swap_horiz',
    title: 'Stock transfers',
    subtitle: 'Tells the branch what stock has just moved in or out, and how much.',
  },
  {
    key: 'warranty',
    icon: 'verified',
    title: 'Warranty expiry',
    subtitle: 'Rings before a promise lapses, and again once it has — so no claim is honoured by mistake.',
  },
  {
    key: 'dues',
    icon: 'account_balance_wallet',
    title: 'Dues (বাকি)',
    subtitle: 'Rings with the total owed and the largest debtor, so collection day picks itself.',
  },
  {
    key: 'summary',
    icon: 'storefront',
    title: 'Today so far',
    subtitle: 'A quiet line with the day’s takings and sale count. Information, never an alarm.',
  },
]

export function createNotificationsSettings(host: SettingsScreenHost): HTMLElement {
  let prefs = { ...DEFAULT_PREFS, ...host.prefs() }

  const root = h('div', { class: 'flex w-full flex-col gap-4 p-4' })

  function persist(message: string): void {
    void host.save(prefs).then(() => toastSuccess(message))
  }

  root.append(
    card(
      cardHeader('Featured notifications', {
        subtitle: 'The bell on the top bar watches the shop. Choose which of its watchers may ring.',
      })
    )
  )

  for (const watcher of WATCHERS) {
    const toggle = h('input', { type: 'checkbox' }) as HTMLInputElement
    toggle.checked = prefs[watcher.key]
    toggle.className = 'h-5 w-5 cursor-pointer rounded border-input text-primary focus:ring-2 focus:ring-ring'
    toggle.dataset.watcher = watcher.key
    toggle.addEventListener('change', () => {
      prefs = { ...prefs, [watcher.key]: toggle.checked }
      persist(toggle.checked ? `${watcher.title} is on.` : `${watcher.title} is off — the bell stays quiet about it.`)
    })

    const rows: HTMLElement[] = [
      h(
        'div',
        { class: 'flex items-center justify-between gap-3' },
        h('p', { class: 'text-sm text-content-muted', text: watcher.subtitle }),
        toggle
      ),
    ]

    if (watcher.key === 'dues') {
      const floorBox = input({
        value: prefs.dueFloorMinor > 0 ? String(prefs.dueFloorMinor / 100) : '',
        placeholder: '0',
      })
      floorBox.inputMode = 'decimal'
      floorBox.addEventListener('change', () => {
        const parsed = parseMinor(floorBox.value)
        prefs = { ...prefs, dueFloorMinor: parsed === null ? 0 : parsed }
        persist(
          prefs.dueFloorMinor > 0
            ? `Dues under ${formatMoney(minor(prefs.dueFloorMinor), { currency: host.currency, convert: false })} stay out of the bell.`
            : 'Every due counts.'
        )
      })
      rows.push(
        field(`Ignore dues below (${host.currency})`, floorBox, {
          hint: 'A floor keeps small neighbourly baki from ringing the bell. Leave empty to hear about every taka.',
        })
      )
    }

    root.append(card(cardHeader(watcher.title, {}), h('div', { class: 'flex flex-col gap-3' }, ...rows)))
  }

  root.append(
    card(
      cardHeader('How it behaves', {}),
      h(
        'ul',
        { class: 'flex list-disc flex-col gap-2 pl-5 text-sm text-content' },
        h('li', { text: 'Everything is computed fresh from the shop’s own books — there is no queue of stale alerts to clean up.' }),
        h('li', { text: '“Read” is per device. What the owner has dismissed still rings on the counter, and the other way round.' }),
        h('li', { text: 'A dismissed alert returns the moment the fact behind it changes — one more product runs out, the due total moves.' }),
        h('li', { text: 'The urgent strip under the top bar shows only the single most pressing unread item, and only until it is dismissed.' })
      )
    )
  )

  return root
}
