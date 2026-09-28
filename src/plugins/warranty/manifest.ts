/**
 * Warranty — manifest.
 *
 * Pure data, no imports from the core and no side effects, so the Plugins
 * screen can list it without loading a line of its behaviour (docs/05 §1).
 *
 * The facts here must match `public.plugin_packages` in the database — the
 * validator asserts that, so a version or a permission key cannot be changed
 * on one side only.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

/**
 * The product field this plugin registers, and the key the shop taxonomy
 * promotes for electronics, computer, mobile and appliance shops
 * (`data/shop_categories.json`). It is the *intention* a shop states on a
 * product; the promise itself is written when the product is sold.
 */
export const WARRANTY_MONTHS_KEY = 'warranty_months'

/** Settings keys. The server reads these out of `plugins.config` by name. */
export const COVER_ALL_KEY = 'cover_all_lines'
export const DEFAULT_MONTHS_KEY = 'default_months'
export const WARN_DAYS_KEY = 'warn_days'
export const CLAIM_PREFIX_KEY = 'claim_prefix'
export const AUTO_REGISTER_KEY = 'auto_register'

export const DEFAULT_COVER_ALL = false
export const DEFAULT_MONTHS = 12
export const DEFAULT_WARN_DAYS = 30
export const DEFAULT_CLAIM_PREFIX = 'WC-'
export const DEFAULT_AUTO_REGISTER = true

export const WARRANTY_VIEW = 'warranty.view'
export const WARRANTY_MANAGE = 'warranty.manage'

/** How far back the work queue looks for sales that still owe a promise. */
export const PENDING_WINDOW_DAYS = 60

/** The longest promise a line is split into per-unit rows for. */
export const MAX_UNITS_PER_LINE = 50

export const warrantyManifest: PluginManifest = {
  id: 'warranty',
  name: 'Warranty',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  category: 'optional',
  // The one that stays free: a shop should be able to keep a promise without paying for the privilege.
  pricing: {
    plan: 'free',
    priceBdt: 0,
  },
  icon: 'verified_user',
  description:
    'Keep the promises a sale makes — which unit, until when, to whom — and what honouring them cost.',
  dataOwnership: 'persistent',
  permissions: [
    {
      key: 'warranty.view',
      label: 'See warranty cover',
      group: 'service',
      description:
        'Look up what a unit is covered by, when the cover ends, and whether it has been in for repair.',
    },
    {
      key: 'warranty.manage',
      label: 'Write and honour warranty cover',
      group: 'service',
      description:
        'Record the promises a sale makes, name the units they cover, open claims and settle them.',
    },
  ],
  settingsSchema: [
    {
      key: AUTO_REGISTER_KEY,
      label: 'Write the promise as soon as a sale completes',
      type: 'boolean',
      default: DEFAULT_AUTO_REGISTER,
      helpText:
        'On by default: a sale that promises cover records it without anybody opening the warranty card. Anything missed — a till that was offline, a plugin switched on later — is listed on the Warranty screen to put right.',
    },
    {
      key: COVER_ALL_KEY,
      label: 'Cover everything I sell',
      type: 'boolean',
      default: DEFAULT_COVER_ALL,
      helpText:
        'For a shop whose guarantee is the same on every line: a product with its own warranty months still wins, and everything else gets the default below.',
    },
    {
      key: DEFAULT_MONTHS_KEY,
      label: 'Default cover, in months',
      type: 'number',
      default: DEFAULT_MONTHS,
      min: 0,
      max: 120,
      helpText: 'Used only when “cover everything I sell” is on and the product says nothing itself.',
    },
    {
      key: WARN_DAYS_KEY,
      label: 'Warn me this long before cover ends',
      type: 'number',
      default: DEFAULT_WARN_DAYS,
      min: 1,
      max: 365,
      helpText: 'Sets the “expiring” count on the dashboard tile and the register’s expiring filter.',
    },
    {
      key: CLAIM_PREFIX_KEY,
      label: 'Prefix for claim slips',
      type: 'text',
      default: DEFAULT_CLAIM_PREFIX,
      placeholder: DEFAULT_CLAIM_PREFIX,
      helpText: 'A claim slip is numbered `WC-2026-000004`. Up to eight characters.',
    },
  ],
}

/**
 * The key the till keeps the sale it is watching under, in this device's own
 * storage. Named here rather than in `index.ts` so a test can assert on the
 * exact key without importing the plugin's behaviour.
 */
export const LAST_SALE_KEY = 'last_registered_sale'
