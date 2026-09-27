/**
 * Notifications — the engine.
 *
 * Pure translation, away from the DOM: the shop's preferences read from
 * the config bag, the server's feed turned into a ranked list of items,
 * and the "seen" arithmetic that decides what still counts as new.
 *
 * ── What "read" means here ───────────────────────────────────────────────
 * Nothing is marked on the server. Each item carries a *signature* built
 * from what it says; "mark all read" stores the set of signatures on this
 * device. An item is new until its signature is stored — and the moment
 * the fact behind it changes (one more product runs out, the due total
 * moves), the signature changes with it and the item rings again. That is
 * the correct behaviour for an alarm: acknowledging it silences *this*
 * state of the world, not the subject.
 */

import { formatMoney, minor } from '../../shared/domain/money'
import type { PluginSettings } from '../../shared/registry/plugin-types'

export interface NotificationPrefs {
  /** Products out of stock or at/under their reorder point. */
  stock: boolean
  /** Customers whose due crossed the floor. */
  dues: boolean
  /** The day so far — sales count and takings. */
  summary: boolean
  /** Ignore dues below this many minor units. 0 = every due counts. */
  dueFloorMinor: number
}

export const DEFAULT_PREFS: NotificationPrefs = {
  stock: true,
  dues: true,
  summary: true,
  dueFloorMinor: 0,
}

const KEYS = {
  stock: 'featureStock',
  dues: 'featureDues',
  summary: 'featureSummary',
  dueFloorMinor: 'dueFloorMinor',
} as const

export function readPrefs(settings: PluginSettings): NotificationPrefs {
  const floor = settings.get<number>(KEYS.dueFloorMinor, 0)
  return {
    stock: settings.get<boolean>(KEYS.stock, true) !== false,
    dues: settings.get<boolean>(KEYS.dues, true) !== false,
    summary: settings.get<boolean>(KEYS.summary, true) !== false,
    dueFloorMinor: Number.isFinite(floor) && floor > 0 ? Math.trunc(floor) : 0,
  }
}

export async function writePrefs(settings: PluginSettings, prefs: NotificationPrefs): Promise<void> {
  await settings.set(KEYS.stock, prefs.stock)
  await settings.set(KEYS.dues, prefs.dues)
  await settings.set(KEYS.summary, prefs.summary)
  await settings.set(KEYS.dueFloorMinor, prefs.dueFloorMinor)
}

/** The wire shape of `notifications_feed`. Absent sections were not asked for. */
export interface NotificationsFeed {
  generated_at?: string
  stock?: {
    out_count: number
    out_names: string[]
    low_count: number
    low_names: string[]
  } | null
  dues?: {
    debtor_count: number
    total_due_minor: number
    top_name: string | null
    top_due_minor: number
  } | null
  summary?: {
    sale_count: number
    total_minor: number
  } | null
}

export type Severity = 'danger' | 'warning' | 'info'

export interface NotificationItem {
  /** Stable id of the *kind* — one bell entry per kind. */
  id: 'out-of-stock' | 'low-stock' | 'dues' | 'summary'
  severity: Severity
  icon: string
  title: string
  body: string
  /** Where tapping the item takes you. */
  route: string
  /** Signature of this exact state — see the header note. */
  signature: string
}

const SEVERITY_RANK: Record<Severity, number> = { danger: 0, warning: 1, info: 2 }

/**
 * Feed → ranked items. Empty sections produce nothing: a bell with no news
 * shows a quiet bell, not a list of zeros.
 */
export function buildItems(feed: NotificationsFeed, prefs: NotificationPrefs, currency: string): NotificationItem[] {
  const items: NotificationItem[] = []
  const taka = (value: number): string =>
    formatMoney(minor(value), { currency, digits: 'latin' })

  if (prefs.stock && feed.stock) {
    const { out_count, out_names, low_count, low_names } = feed.stock
    if (out_count > 0) {
      items.push({
        id: 'out-of-stock',
        severity: 'danger',
        icon: 'production_quantity_limits',
        title: out_count === 1 ? '1 product is out of stock' : `${out_count} products are out of stock`,
        body: names(out_names, out_count),
        route: '/stock',
        signature: `out:${out_count}:${out_names.join('|')}`,
      })
    }
    if (low_count > 0) {
      items.push({
        id: 'low-stock',
        severity: 'warning',
        icon: 'inventory_2',
        title: low_count === 1 ? '1 product is running low' : `${low_count} products are running low`,
        body: names(low_names, low_count),
        route: '/stock',
        signature: `low:${low_count}:${low_names.join('|')}`,
      })
    }
  }

  if (prefs.dues && feed.dues && feed.dues.debtor_count > 0) {
    const { debtor_count, total_due_minor, top_name, top_due_minor } = feed.dues
    items.push({
      id: 'dues',
      severity: 'warning',
      icon: 'account_balance_wallet',
      title: `${taka(total_due_minor)} due from ${debtor_count} customer${debtor_count === 1 ? '' : 's'}`,
      body: top_name ? `Largest: ${top_name}, ${taka(top_due_minor)}.` : '',
      route: '/customers',
      signature: `dues:${debtor_count}:${total_due_minor}`,
    })
  }

  if (prefs.summary && feed.summary && feed.summary.sale_count > 0) {
    const { sale_count, total_minor } = feed.summary
    items.push({
      id: 'summary',
      severity: 'info',
      icon: 'storefront',
      title: `Today so far: ${taka(total_minor)}`,
      body: `${sale_count} sale${sale_count === 1 ? '' : 's'} since midnight.`,
      route: '/dashboard',
      // The day summary refreshes as a fact of life; signing it hourly
      // keeps the bell from ringing on every poll while the shop trades.
      signature: `today:${sale_count}:${total_minor}`,
    })
  }

  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

function names(list: string[], total: number): string {
  if (list.length === 0) return ''
  const shown = list.join(', ')
  return total > list.length ? `${shown} and ${total - list.length} more.` : `${shown}.`
}

/** How many of these items this device has not acknowledged yet. */
export function unseenCount(items: NotificationItem[], seen: readonly string[]): number {
  return items.filter((item) => !seen.includes(item.signature)).length
}

/** What "mark all read" stores: exactly the signatures currently shown. */
export function seenSignatures(items: NotificationItem[]): string[] {
  return items.map((item) => item.signature)
}
