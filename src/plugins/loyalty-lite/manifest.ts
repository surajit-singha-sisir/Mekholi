/**
 * Loyalty (lite) — manifest. The SDK's worked example (docs/05 §7).
 *
 * Depends on batch-expiry on purpose: it is the only pair in this bundle that
 * makes the dependency rules observable — the toggle greys out, the resolver
 * orders them, and the database refuses to disable the dependency while this
 * one is enabled.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

export const POINTS_PER_CURRENCY_KEY = 'points_per_currency'
export const AUTO_AWARD_KEY = 'auto_award'

export const loyaltyLiteManifest: PluginManifest = {
  id: 'loyalty-lite',
  name: 'Loyalty (lite)',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 149,
    trialDays: 14,
  },
  icon: 'card_membership',
  description: 'Points per customer, earned on completed sales.',
  dependencies: ['batch-expiry'],
  dataOwnership: 'persistent',
  permissions: [
    {
      key: 'loyalty-lite.view',
      label: 'View loyalty accounts',
      group: 'customers',
      description: 'See points balances and the loyalty screen.',
    },
    {
      key: 'loyalty-lite.manage',
      label: 'Manage loyalty points',
      group: 'customers',
      description: 'Adjust points, including manual corrections.',
    },
  ],
  settingsSchema: [
    {
      key: POINTS_PER_CURRENCY_KEY,
      label: 'Points per currency unit',
      type: 'number',
      default: 1,
      min: 0,
      step: 0.1,
      helpText: 'How many points a customer earns per 1 unit of currency spent.',
    },
    {
      key: 'redeem_rate',
      label: 'Points needed to equal 1 currency unit',
      type: 'number',
      default: 100,
      min: 1,
      step: 1,
      helpText: 'Written on the receipt; redemption itself arrives with the full plugin.',
    },
    {
      key: AUTO_AWARD_KEY,
      label: 'Award points automatically on a completed sale',
      type: 'boolean',
      default: false,
      helpText: 'Off by default: a shop turns this on once it trusts the rate.',
    },
  ],
}
