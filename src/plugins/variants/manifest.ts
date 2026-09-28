/**
 * Variants — manifest.
 *
 * Pure data and no side effects, like every manifest: the Plugins screen lists
 * this plugin (and its settings form) without ever importing its behaviour.
 *
 * The facts here must match `public.plugin_packages` in migration 041 — id,
 * version and every permission key. `npm run validate:migrations` compares the
 * two, so a version bumped on one side only fails the build rather than
 * producing a bundle that asks the server for functions it never created.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

/** The key `app.variants_config` reads out of the plugin's config. */
export const MAX_VARIANTS_KEY = 'max_variants'

/**
 * What the database defaults to, repeated here so a settings read that never
 * happened still shows the shop the number it is actually under.
 */
export const DEFAULT_MAX_VARIANTS = 200

export const variantsManifest: PluginManifest = {
  id: 'variants',
  name: 'Variants',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 249,
    trialDays: 14,
  },
  icon: 'grid_view',
  description:
    'Build a product’s variants from its options — size, colour, capacity — and price them in one pass.',
  // The shop's options and the variants built from them live in core tables
  // (`product_option_types`, `product_variants`), exactly as spec §51 wants:
  // switching this plugin off must not take a shop's catalogue with it.
  dataOwnership: 'persistent',
  permissions: [
    {
      key: 'variants.view',
      label: 'See product variants',
      group: 'products',
      description: 'See a product’s options and the combinations built from them.',
    },
    {
      key: 'variants.manage',
      label: 'Manage product variants',
      group: 'products',
      description:
        'Choose which options a product has, generate combinations, edit them in bulk.',
    },
  ],
  settingsSchema: [
    {
      key: MAX_VARIANTS_KEY,
      label: 'Most variants one product may have',
      type: 'number',
      default: DEFAULT_MAX_VARIANTS,
      min: 1,
      max: 2000,
      helpText:
        'A ceiling on one product’s matrix. A shop that sells t-shirts by size and colour needs a few dozen; a shop that accidentally ticks every value of six options is stopped here rather than by an afternoon of deleting.',
    },
  ],
}
