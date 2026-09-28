/**
 * Due book (বাকির খাতা) — the manifest.
 *
 * Selling on credit is the oldest feature of the Bangladeshi shop: the
 * khata under the counter, a name, a figure, a promise. The server-side
 * ledger is core (057) — balances derived from sales, dues that must name
 * their debtor — because money integrity is not optional equipment. What
 * this plugin owns is every *surface* of it: the debtors screen, the
 * dashboard tile, and (by the client gating on the plugin being loaded)
 * the "keep as due" button on the till and "collect due" on the customer
 * card.
 *
 * A shop that never sells on credit leaves this off and the whole idea
 * disappears from its screens at once. Free: the khata predates software,
 * and charging rent on it would be charging for paper.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

export const DUE_LEDGER_ID = 'due-ledger'

/**
 * Gated on the core customers permission (056 philosophy — no invented
 * keys): whoever may see the customers may see what they owe, and the
 * collecting itself is guarded server-side by `sales.create`.
 */
export const DUE_VIEW = 'customers.view'

export const dueLedgerManifest: PluginManifest = {
  id: DUE_LEDGER_ID,
  name: 'Due book (বাকির খাতা)',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'Sell on credit and keep the khata: who owes what, since when, and the collection buttons on the till and the customer card.',
  category: 'optional',
  pricing: {
    plan: 'free',
    priceBdt: 0,
  },
  icon: 'menu_book',
  // No permissions of its own — see DUE_VIEW above.
  permissions: [],
  dataOwnership: 'transient',
}
