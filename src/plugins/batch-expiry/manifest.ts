/**
 * Batch & expiry — manifest.
 *
 * Pure data, no imports from core and no side effects, so the Plugins screen
 * can list every plugin this bundle ships by importing a few hundred bytes
 * each and never pulling in their behaviour (docs/05 §1).
 *
 * The facts here must match `public.plugin_packages` in the database — the
 * validator asserts that, so a version cannot be bumped on one side only.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

export const BATCH_KEY = 'batch_number'
export const EXPIRY_KEY = 'expiry_date'

/** Default warning window, in days. A shop changes it in the plugin's settings. */
export const DEFAULT_WARNING_DAYS = 90

export const batchExpiryManifest: PluginManifest = {
  id: 'batch-expiry',
  name: 'Batch & Expiry',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 349,
    trialDays: 14,
  },
  icon: 'event_busy',
  description: 'Track batch numbers and expiry dates. Warns before stock expires.',
  dataOwnership: 'persistent',
  permissions: [
    {
      key: 'batch-expiry.adjust',
      label: 'Edit batch and expiry details',
      group: 'inventory',
      description: 'Allows editing batch numbers and expiry dates on products.',
    },
  ],
  settingsSchema: [
    {
      key: 'warning_days',
      label: 'Warn me this many days before expiry',
      type: 'number',
      default: DEFAULT_WARNING_DAYS,
      min: 1,
      max: 365,
      helpText: 'Stock inside this window is listed on the Expiry Watch screen and tiles.',
    },
  ],
}
