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
  /** Warranties that have lapsed or are about to. */
  warranty: boolean
  /** Stock moved between branches, so a branch hears what arrived and what left. */
  transfers: boolean
  /** Ignore dues below this many minor units. 0 = every due counts. */
  dueFloorMinor: number
}

export const DEFAULT_PREFS: NotificationPrefs = {
  stock: true,
  dues: true,
  summary: true,
  warranty: true,
  transfers: true,
  dueFloorMinor: 0,
}

const KEYS = {
  stock: 'featureStock',
  dues: 'featureDues',
  summary: 'featureSummary',
  warranty: 'featureWarranty',
  transfers: 'featureTransfers',
  dueFloorMinor: 'dueFloorMinor',
} as const

export function readPrefs(settings: PluginSettings): NotificationPrefs {
  const floor = settings.get<number>(KEYS.dueFloorMinor, 0)
  return {
    stock: settings.get<boolean>(KEYS.stock, true) !== false,
    dues: settings.get<boolean>(KEYS.dues, true) !== false,
    summary: settings.get<boolean>(KEYS.summary, true) !== false,
    warranty: settings.get<boolean>(KEYS.warranty, true) !== false,
    transfers: settings.get<boolean>(KEYS.transfers, true) !== false,
    dueFloorMinor: Number.isFinite(floor) && floor > 0 ? Math.trunc(floor) : 0,
  }
}

export async function writePrefs(settings: PluginSettings, prefs: NotificationPrefs): Promise<void> {
  await settings.set(KEYS.stock, prefs.stock)
  await settings.set(KEYS.dues, prefs.dues)
  await settings.set(KEYS.summary, prefs.summary)
  await settings.set(KEYS.warranty, prefs.warranty)
  await settings.set(KEYS.transfers, prefs.transfers)
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
  warranty?: {
    /** ACTIVE promises whose end date falls inside the horizon. */
    expiring_count: number
    /** ACTIVE promises whose end date has already passed. */
    expired_count: number
    /** How many days ahead "expiring" looks. */
    horizon_days: number
    /** The promise ending soonest, for the sentence. */
    soonest_name: string | null
    soonest_ends_on: string | null
    /** Up to five product names ending inside the horizon. */
    expiring_names: string[]
  } | null
  transfers?: {
    /** Transfers recorded inside the window. */
    count: number
    /** Total units moved across those transfers. */
    unit_count: number
    /** The most recent movement's endpoints, named. */
    latest_from: string | null
    latest_to: string | null
    /** Up to five product names on the most recent transfer. */
    latest_names: string[]
    /** How many hours back the count reaches. */
    window_hours: number
  } | null
}

export type Severity = 'danger' | 'warning' | 'info'

export interface NotificationItem {
  /** Stable id of the *kind* — one bell entry per kind. */
  id:
    | 'out-of-stock'
    | 'low-stock'
    | 'dues'
    | 'summary'
    | 'warranty-expiring'
    | 'warranty-expired'
    | 'stock-transfer'
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
        title:
          low_count === 1
            ? '1 product reached its reorder point'
            : `${low_count} products reached their reorder point`,
        body: `${names(low_names, low_count)} Reorder before the shelf runs dry.`.trim(),
        route: '/stock?filter=low',
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

  if (prefs.warranty && feed.warranty) {
    const { expiring_count, expired_count, horizon_days, soonest_name, soonest_ends_on, expiring_names } =
      feed.warranty
    if (expiring_count > 0) {
      const soon =
        soonest_name && soonest_ends_on
          ? `Soonest: ${soonest_name}, ends ${shortDate(soonest_ends_on)}.`
          : ''
      const list = expiring_names.length ? ` ${names(expiring_names, expiring_count)}` : ''
      items.push({
        id: 'warranty-expiring',
        severity: 'warning',
        icon: 'verified',
        title:
          expiring_count === 1
            ? `1 warranty expires within ${horizon_days} days`
            : `${expiring_count} warranties expire within ${horizon_days} days`,
        body: `${soon}${list}`.trim(),
        route: '/plugins/warranty',
        signature: `warr-exp:${expiring_count}:${soonest_ends_on ?? ''}`,
      })
    }
    if (expired_count > 0) {
      items.push({
        id: 'warranty-expired',
        severity: 'warning',
        icon: 'gpp_maybe',
        title:
          expired_count === 1
            ? '1 warranty has lapsed'
            : `${expired_count} warranties have lapsed`,
        body: 'Their cover has ended — check before honouring a claim.',
        route: '/plugins/warranty',
        signature: `warr-lapsed:${expired_count}`,
      })
    }
  }

  if (prefs.transfers && feed.transfers && feed.transfers.count > 0) {
    const { count, unit_count, latest_from, latest_to, latest_names, window_hours } = feed.transfers
    const window = window_hours >= 24 ? `${Math.round(window_hours / 24)}d` : `${window_hours}h`
    const leg =
      latest_from && latest_to
        ? ` Latest: ${latest_from} → ${latest_to}.`
        : ''
    const list = latest_names.length ? ` ${names(latest_names, latest_names.length)}` : ''
    items.push({
      id: 'stock-transfer',
      severity: 'info',
      icon: 'swap_horiz',
      title:
        count === 1
          ? `1 stock transfer · ${unit_count} unit${unit_count === 1 ? '' : 's'} moved`
          : `${count} stock transfers · ${unit_count} unit${unit_count === 1 ? '' : 's'} moved`,
      body: `In the last ${window}.${leg}${list}`.trim(),
      route: '/stock',
      signature: `xfer:${count}:${unit_count}:${latest_to ?? ''}`,
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A `YYYY-MM-DD` date, read as the plain day it is — never as a timestamp, so
 * no timezone can shift a warranty's last day across midnight. Anything that is
 * not a clean date is shown as-is rather than guessed at.
 */
function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return iso
  const [, year, month, day] = match
  const name = MONTHS[Number(month) - 1]
  return name ? `${Number(day)} ${name} ${year}` : iso
}

/** How many of these items this device has not acknowledged yet. */
export function unseenCount(items: NotificationItem[], seen: readonly string[]): number {
  return items.filter((item) => !seen.includes(item.signature)).length
}

/** What "mark all read" stores: exactly the signatures currently shown. */
export function seenSignatures(items: NotificationItem[]): string[] {
  return items.map((item) => item.signature)
}
