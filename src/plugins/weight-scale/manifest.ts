/**
 * Weighing scale — the manifest.
 *
 * Data only, and cheap to import: the app reads this without running a line of
 * the plugin's code, so a disabled plugin still costs nothing but this object.
 *
 * The plugin exists because of one sentence in a grocery owner's day: *"it says
 * 1.250 kg, why can I not just scan it?"* — the shop's scale prints a label
 * whose code is not, and never will be, a row in the shop's barcode table, and
 * before scan resolvers the till had nowhere to ask. Everything this plugin does
 * follows from reading that label correctly and from telling the shop which of
 * its items its own scale cannot ring up at all.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

export const WEIGHT_SCALE_ID = 'weight-scale'

/** See what the shop weighs, and what its scale can and cannot sell. */
export const WEIGHT_VIEW = 'weight-scale.view'

/** Describe the shop's own scale labels, so the till can read them. */
export const WEIGHT_MANAGE = 'weight-scale.manage'

/**
 * Where the shop's label layouts live: `plugins.config.formats`, written by this
 * plugin's screen and read by the till on every scan. The same key is read by
 * the server half (`app.weight_scale_formats`) when a report is built, so the
 * layout a report was made from is the layout the till is using.
 */
export const FORMATS_KEY = 'formats'

/** Whether a price printed on a label is shown to the cashier. */
export const REPORT_LABEL_PRICE_KEY = 'report_label_price'

export const DEFAULT_REPORT_LABEL_PRICE = true

/**
 * The settings a shop can change without opening the plugin's screen.
 *
 * The layouts are deliberately *not* here: they are a list with four numbers
 * each, and a settings schema that can render text, number, boolean and select
 * would turn them into JSON a shopkeeper has to type correctly. They get a
 * screen with a test box instead — which is also the only way to find out
 * whether a layout is right, since the feedback is a scanner, not a label.
 */
export const weightScaleManifest: PluginManifest = {
  // Written out rather than referenced, for the same reason the permission keys
  // are: the shipped bundle is compared with *this file* by reading it.
  id: 'weight-scale',
  name: 'Weighing scale',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'Sell by weight: the till reads your scale’s labels, and the shop sees which items its scale cannot ring up.',
  category: 'industry',
  pricing: {
    plan: 'paid',
    priceBdt: 299,
    trialDays: 14,
  },
  icon: 'scale',
  // The keys are written as literals, not as the constants above: the bundle
  // the server ships is compared against this manifest by reading the file, so
  // a key that only exists as an identifier would compare as a missing
  // permission. The constants stay for the code that checks them at runtime.
  permissions: [
    {
      key: 'weight-scale.view',
      label: 'See weighed sales',
      group: 'inventory',
      description:
        'See what left the shop by weight and which items the scale cannot sell.',
    },
    {
      key: 'weight-scale.manage',
      label: 'Describe the scale’s labels',
      group: 'inventory',
      description:
        'Tell the till how this shop’s scale prints a label, so a scanned label can find its product.',
    },
  ],
  settingsSchema: [
    {
      key: REPORT_LABEL_PRICE_KEY,
      label: 'Read the price a label carries',
      type: 'boolean',
      default: DEFAULT_REPORT_LABEL_PRICE,
      helpText:
        'Show the cashier the price the scale printed and warn when it differs from the shelf price. The shop’s own price is always what is charged.',
    },
  ],
  dataOwnership: 'persistent',
}
