/**
 * Notifications — the manifest.
 *
 * The shop that watches itself. Three things are worth interrupting a
 * shopkeeper for, and only three: something sold out, somebody owes real
 * money, and how the day is going. This plugin turns them into a bell on
 * the top bar — the one strip of screen every view shares — with a
 * featured strip underneath it when one of them turns urgent.
 *
 * Which of the three may ring, and from what amount, is the shop's own
 * choice on the plugin's settings screen. Nothing is stored server-side:
 * the feed derives every alert from the shop's own tables at the moment
 * of asking, so the bell can be wrong by at most one poll — and "read"
 * is a per-device mark, because what the owner has seen says nothing
 * about what the cashier has.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'

export const NOTIFICATIONS_ID = 'notifications'

/**
 * The bell is gated on the core dashboard permission: it summarises the
 * same numbers the dashboard shows, so whoever may read the one may read
 * the other (056 philosophy: no invented keys). The settings screen is
 * settings work and gates on `settings.view`, like printer-setup.
 */
export const NOTIFICATIONS_VIEW = 'dashboard.view'
export const NOTIFICATIONS_MANAGE = 'settings.view'

export const notificationsManifest: PluginManifest = {
  id: NOTIFICATIONS_ID,
  name: 'Notifications',
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'A bell on the top bar that watches the shop: products running out, dues past your threshold, and how today is going — you choose which of them may ring.',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 99,
    trialDays: 14,
  },
  icon: 'notifications',
  // No permissions of its own — see the two gates above.
  permissions: [],
  // Its state is a handful of org-scoped toggles; disabling keeps them.
  dataOwnership: 'transient',
}
