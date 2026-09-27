/**
 * Label printing — the manifest.
 *
 * The plugin exists because of the shop that scanning was sold to and never
 * arrived at: half its shelf is loose local goods with no printed barcode,
 * so the scanner it bought reads the Coca-Cola and nothing the shop itself
 * packs. The fix has always been the same — print your own labels from your
 * own SKUs — and until this plugin the app knew the SKUs and offered no way
 * to put them on paper.
 *
 * Free, like the other two hardware plugins (`printer-setup`,
 * `barcode-scanner`): charging for the label is charging for the scanner
 * working, and the scanner working is why the shop stays.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'

export const LABEL_PRINTING_ID = 'label-printing'

/**
 * Gated on the core catalogue permission rather than a key of its own, like
 * the other two hardware plugins (056): whoever may see the products may put
 * their SKUs on paper. Inventing `label-printing.print` would add a key every
 * role has to be taught for no decision it enables.
 */
export const LABELS_PRINT = 'products.view'

export const labelPrintingManifest: PluginManifest = {
  id: 'label-printing',
  name: 'Label printing',
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'Print barcode labels from your own SKUs — for the half of the shelf no factory ever labelled.',
  category: 'optional',
  pricing: {
    plan: 'free',
    priceBdt: 0,
  },
  icon: 'label',
  // No permissions of its own — see LABELS_PRINT above.
  permissions: [],
  dataOwnership: 'transient',
}
