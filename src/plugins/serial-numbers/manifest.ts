/**
 * Serial Numbers — manifest.
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
 * The product field this plugin registers, and the one the shop taxonomy
 * promotes for the shops that need it (`data/shop_categories.json`).
 */
export const SERIAL_TRACKED_KEY = 'serial_tracked'

/** Settings keys. The server reads these out of `plugins.config` by name. */
export const REQUIRE_CAPTURE_KEY = 'require_capture'
export const INTERNAL_PREFIX_KEY = 'internal_prefix'
export const ALLOW_OVER_STOCK_KEY = 'allow_over_stock'

export const DEFAULT_REQUIRE_CAPTURE = true
export const DEFAULT_INTERNAL_PREFIX = 'SN-'
export const DEFAULT_ALLOW_OVER_STOCK = false

export const SERIALS_VIEW = 'serial-numbers.view'
export const SERIALS_MANAGE = 'serial-numbers.manage'

/** How far back the plugin looks for sales that still need a unit number. */
export const PENDING_WINDOW_DAYS = 60

export const serialNumbersManifest: PluginManifest = {
  id: 'serial-numbers',
  name: 'Serial Numbers',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 399,
    trialDays: 14,
  },
  icon: 'qr_code_scanner',
  description:
    'Track every unit by its own number — IMEI, engine number, case number — from delivery to invoice.',
  dataOwnership: 'persistent',
  permissions: [
    {
      key: 'serial-numbers.view',
      label: 'See serial numbers',
      group: 'inventory',
      description:
        'Look up a unit by its number and see what it is, where it is and which sale it left on.',
    },
    {
      key: 'serial-numbers.manage',
      label: 'Add and capture serial numbers',
      group: 'inventory',
      description:
        'Register units, attach them to a sale, mint internal codes, and put a returned unit back in stock.',
    },
  ],
  settingsSchema: [
    {
      key: 'require_capture',
      label: 'Flag sales that leave without a serial',
      type: 'boolean',
      default: DEFAULT_REQUIRE_CAPTURE,
      helpText:
        'Turns on the warning tile and the “needs a serial” list. A sale is never blocked — a till has to work even when nobody scans.',
    },
    {
      key: 'internal_prefix',
      label: 'Prefix for internally generated codes',
      type: 'text',
      default: DEFAULT_INTERNAL_PREFIX,
      placeholder: DEFAULT_INTERNAL_PREFIX,
      helpText:
        'Used when a shop did not scan: `SN-000042`. Leave the field empty after saving to switch generation off.',
    },
    {
      key: 'allow_over_stock',
      label: 'Allow labelling more units than are in stock',
      type: 'boolean',
      default: DEFAULT_ALLOW_OVER_STOCK,
      helpText:
        'Off by default, so the pool cannot outgrow the shelf. Turn it on if labels are printed before the delivery is received.',
    },
  ],
}

/**
 * The key the till keeps its unattached scans under, in this device's own
 * storage. Named here rather than in `index.ts` so a test can assert on the
 * exact key without importing the plugin's behaviour.
 */
export const TILL_PENDING_KEY = 'pending_scans'
