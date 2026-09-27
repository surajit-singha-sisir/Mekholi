/**
 * Bangladesh VAT (মূসক) — the manifest.
 *
 * The Mushak-6.3 machinery (template, BIN line, VAT row) ships in the core
 * receipt renderer, because a saved design must keep printing even if a
 * plugin is later switched off — a shop's tax documents are not hostage to
 * a toggle. What *this* plugin owns is the Bangladesh-specific surface:
 * the switch that makes Mushak-6.3 the shop's invoice, the BIN, and the
 * guide that explains the system the form belongs to (docs/18).
 *
 * A shop outside Bangladesh, or under the registration threshold, simply
 * never enables it — and the printer-setup card then never offers a VAT
 * invoice it should not be issuing.
 *
 * Free: charging for tax compliance is charging a shop for obeying the law.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'

export const BD_VAT_ID = 'bd-vat'

/**
 * Gated on the core settings permission, like printer-setup: deciding what
 * the shop's invoice looks like is settings work, and inventing `bd-vat.*`
 * keys would add nothing a role editor can act on (the 056 philosophy).
 */
export const BD_VAT_MANAGE = 'settings.view'

export const bdVatManifest: PluginManifest = {
  id: BD_VAT_ID,
  name: 'Bangladesh VAT (Mushak)',
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'The NBR Mushak-6.3 tax invoice: BIN, the VAT line on every sale, and a plain-words guide to the মূসক system.',
  category: 'industry',
  pricing: {
    plan: 'free',
    priceBdt: 0,
  },
  icon: 'account_balance',
  // No permissions of its own — see BD_VAT_MANAGE above.
  permissions: [],
  dataOwnership: 'transient',
}
