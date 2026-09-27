/**
 * Branches — the manifest.
 *
 * The first *capability* plugin that costs money outside loyalty, and the
 * distinction is deliberate. Everything a single shop needs is core or
 * free: one branch exists from provisioning, the till sells from it, and
 * nobody pays rent on their own counter. What this plugin sells is the
 * second shop — opening branches, and the head-office view of all of
 * them: what each till took today and this week, and what is still owed
 * out there. A shop that has grown to two premises has revenue to match,
 * which is the only honest moment to put a price on software.
 *
 * The entitlement is enforced by the plugin engine (plugin-licence.ts):
 * without a licence the plugin is blocked at load, the nav entry and the
 * branch switcher never appear, and the trial is real and expires.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'

export const BRANCH_ID = 'branch'

/**
 * Core permissions, not invented ones (056): watching branches is
 * `reports.view`, restructuring the business is `settings.business` —
 * both re-checked server-side by the packaged functions.
 */
export const BRANCH_WATCH = 'reports.view'
export const BRANCH_MANAGE = 'settings.business'

export const branchManifest: PluginManifest = {
  id: BRANCH_ID,
  name: 'Branches',
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'Open branches and watch them from the head office: today and this week per branch, dues out, and the switcher on every till.',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 499,
    trialDays: 14,
  },
  icon: 'store',
  // No permissions of its own — see BRANCH_WATCH / BRANCH_MANAGE above.
  permissions: [],
  dataOwnership: 'transient',
}
