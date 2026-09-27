/**
 * Multi-Currency Display — the manifest.
 *
 * A shop keeps its books in one currency; this plugin lets it keep its
 * *eyes* in another. Every stored amount stays in the base currency the
 * shop was set up with (integer minor units, exactly as the money engine
 * demands) — what changes is only what the screen and the printer show:
 * ৳1,400 reads as $11.43 at the shop's own rate.
 *
 * That distinction is the whole design. Converting the display is lossless
 * and reversible; converting the *data* would rewrite history at whatever
 * today's rate happens to be and never quite convert back. So the database
 * is never touched, which is also why this package ships no SQL.
 *
 * The rate comes live from the exchange-rate feed when the device is
 * online, is cached for the days it is not, and can be overridden by hand —
 * the shopkeeper who changes dollars at the corner shop knows their real
 * rate better than any API does.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'

export const MULTI_CURRENCY_ID = 'multi-currency'

/**
 * Gated on the core settings permission, like printer-setup and bd-vat:
 * deciding what currency the shop reads in is settings work, and a
 * `multi-currency.*` permission would add nothing a role editor can act on.
 */
export const MULTI_CURRENCY_MANAGE = 'settings.view'

export const multiCurrencyManifest: PluginManifest = {
  id: MULTI_CURRENCY_ID,
  name: 'Multi-Currency Display',
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'Read every amount in a second currency — live exchange rate when online, cached when not, your own rate when you know better. The books stay in the shop’s base currency.',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 199,
    trialDays: 14,
  },
  icon: 'currency_exchange',
  // No permissions of its own — see MULTI_CURRENCY_MANAGE above.
  permissions: [],
  // Its state is a handful of org-scoped settings keys; disabling the plugin
  // keeps them, re-enabling finds them again. No tables anywhere.
  dataOwnership: 'transient',
}
