/**
 * The bell on the top bar, and the featured strip under it.
 *
 * Two levels of loudness, matched to two kinds of news:
 *
 *  - The **bell** carries a count of what this device has not seen yet.
 *    Open it and the news is ranked — what stops sales first (out of
 *    stock), then what costs money (low stock, dues), then how the day
 *    is going. Tapping an item goes to the screen that fixes it.
 *
 *  - The **strip** appears below the top bar only while the single most
 *    urgent item is still unacknowledged — the one line of the shop's
 *    state that should not wait for a click. Dismissing it acknowledges
 *    that item everywhere in the widget; it returns only when the fact
 *    itself changes.
 *
 * The host element positions both against the header (the widget's
 * nearest positioned ancestor, by the slot's contract), so the strip
 * rides with the sticky bar instead of scrolling away.
 */

import { h, icon, mount } from '../../components/ui/h'
import {
  buildItems,
  seenSignatures,
  unseenCount,
  type NotificationItem,
  type NotificationPrefs,
  type NotificationsFeed,
  type Severity,
} from './engine'

export interface BellHost {
  prefs(): NotificationPrefs
  /** The shop's base currency code, for the money in the sentences. */
  currency(): string
  fetchFeed(prefs: NotificationPrefs): Promise<NotificationsFeed>
  /** Signatures this device has acknowledged. */
  seen(): string[]
  storeSeen(signatures: string[]): void
  /** Navigate the app — the plugin emits, the core drives. */
  go(route: string): void
}

const STRIP_TONES: Record<Severity, string> = {
  danger: 'bg-danger text-danger-foreground',
  warning: 'bg-warning text-warning-foreground',
  info: 'bg-primary text-primary-foreground',
}

const ITEM_TONES: Record<Severity, string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-content-muted',
}

export interface HeaderBell {
  el: HTMLElement
  refresh(): Promise<void>
  dispose(): void
}

export function createHeaderBell(host: BellHost): HeaderBell {
  let items: NotificationItem[] = []
  let open = false

  const root = h('div', { class: 'flex items-center' })

  const countBadge = h('span', {
    class:
      'pointer-events-none absolute -top-0.5 -right-0.5 hidden min-w-[1.1rem] rounded-full bg-danger px-1 ' +
      'text-center text-[10px] font-bold leading-[1.1rem] text-danger-foreground',
  })

  const bellButton = h(
    'button',
    {
      type: 'button',
      class:
        'relative flex h-10 w-10 items-center justify-center rounded-md text-content-muted ' +
        'hover:bg-surface-muted hover:text-content focus:outline-none focus:ring-2 focus:ring-ring',
      'aria-label': 'Notifications',
    },
    icon('notifications', 'text-[22px]'),
    countBadge
  ) as HTMLButtonElement

  const panel = h('div', {
    class:
      'absolute right-2 top-full z-40 mt-1 hidden w-96 max-w-[calc(100vw-1rem)] overflow-hidden ' +
      'rounded-lg border border-border bg-surface shadow-xl',
  })

  const strip = h('div', { class: 'absolute inset-x-0 top-full hidden' })

  root.append(bellButton, panel, strip)

  // ── Drawing ───────────────────────────────────────────────────────────

  function unseen(): NotificationItem[] {
    const seen = host.seen()
    return items.filter((item) => !seen.includes(item.signature))
  }

  function drawBadge(): void {
    const count = unseenCount(items, host.seen())
    countBadge.textContent = count > 9 ? '9+' : String(count)
    countBadge.classList.toggle('hidden', count === 0)
  }

  function drawStrip(): void {
    const urgent = unseen().find((item) => item.severity !== 'info')
    if (!urgent) {
      strip.classList.add('hidden')
      mount(strip, null)
      return
    }
    strip.classList.remove('hidden')
    mount(
      strip,
      h(
        'div',
        { class: `flex items-center gap-2 px-4 py-1.5 text-sm ${STRIP_TONES[urgent.severity]}` },
        icon(urgent.icon, 'text-[18px] shrink-0'),
        h('p', { class: 'min-w-0 flex-1 truncate font-medium', text: `${urgent.title}${urgent.body ? ` — ${urgent.body}` : ''}` }),
        h(
          'button',
          {
            type: 'button',
            class: 'shrink-0 rounded px-2 py-0.5 text-xs font-semibold underline-offset-2 hover:underline',
            onclick: () => {
              closePanel()
              host.go(urgent.route)
            },
          },
          'View'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'flex shrink-0 items-center rounded p-0.5 hover:bg-black/10',
            'aria-label': 'Dismiss',
            onclick: () => {
              host.storeSeen([...host.seen(), urgent.signature])
              drawAll()
            },
          },
          icon('close', 'text-[16px]')
        )
      )
    )
  }

  function drawPanel(): void {
    panel.classList.toggle('hidden', !open)
    if (!open) return

    const seen = host.seen()
    const header = h(
      'div',
      { class: 'flex items-center justify-between gap-2 border-b border-border px-3 py-2' },
      h('p', { class: 'text-sm font-semibold text-content', text: 'Notifications' }),
      items.length > 0
        ? h(
            'button',
            {
              type: 'button',
              class: 'text-xs font-medium text-primary hover:underline',
              onclick: () => {
                host.storeSeen(seenSignatures(items))
                drawAll()
              },
            },
            'Mark all as read'
          )
        : null
    )

    const body =
      items.length === 0
        ? h(
            'div',
            { class: 'flex flex-col items-center gap-1 px-4 py-8 text-center' },
            icon('notifications_off', 'text-[28px] text-content-subtle'),
            h('p', { class: 'text-sm text-content-muted', text: 'All quiet. The shop is behaving.' })
          )
        : h(
            'div',
            { class: 'max-h-[60vh] overflow-y-auto' },
            ...items.map((item) => {
              const isNew = !seen.includes(item.signature)
              return h(
                'button',
                {
                  type: 'button',
                  class:
                    'flex w-full items-start gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 ' +
                    (isNew ? 'bg-surface-muted/60 ' : '') +
                    'hover:bg-surface-muted focus:outline-none focus:bg-surface-muted',
                  onclick: () => {
                    host.storeSeen([...host.seen(), item.signature])
                    open = false
                    drawAll()
                    host.go(item.route)
                  },
                },
                icon(item.icon, `mt-0.5 text-[20px] shrink-0 ${ITEM_TONES[item.severity]}`),
                h(
                  'div',
                  { class: 'min-w-0 flex-1' },
                  h('p', { class: 'text-sm font-medium text-content', text: item.title }),
                  item.body ? h('p', { class: 'mt-0.5 text-xs text-content-muted', text: item.body }) : null
                ),
                isNew ? h('span', { class: 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary' }) : null
              )
            })
          )

    mount(panel, header, body)
  }

  function drawAll(): void {
    drawBadge()
    drawStrip()
    drawPanel()
  }

  function closePanel(): void {
    open = false
    drawPanel()
  }

  // ── Behaviour ─────────────────────────────────────────────────────────

  bellButton.addEventListener('click', (event) => {
    event.stopPropagation()
    open = !open
    drawPanel()
  })

  const onDocumentClick = (event: MouseEvent): void => {
    if (open && !root.contains(event.target as Node)) closePanel()
  }
  document.addEventListener('click', onDocumentClick)

  async function refresh(): Promise<void> {
    try {
      const prefs = host.prefs()
      const feed = await host.fetchFeed(prefs)
      items = buildItems(feed, prefs, host.currency())
    } catch {
      // Offline or the shop lost the permission mid-session: keep showing
      // what we knew. A bell that empties itself on a network blip lies.
      return
    }
    drawAll()
  }

  void refresh()

  return {
    el: root,
    refresh,
    dispose: () => {
      document.removeEventListener('click', onDocumentClick)
    },
  }
}
