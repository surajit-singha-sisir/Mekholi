/**
 * Loyalty — the manifest.
 *
 * Data only, and cheap to import: the app reads this without running a line of
 * the plugin's code, so a shop that never enables loyalty still pays for
 * nothing but this object.
 *
 * The plugin exists because of the sentence a grocery owner says in month two:
 * *"the same people come every week — why do I not know who they are?"* Points
 * are the cheapest honest answer: the shop promises money back, and this plugin
 * keeps the promise countable — every point traceable to the sale that earned
 * it, every redemption traceable to the invoice it paid for.
 */

import type { PluginManifest } from '../../shared/registry/plugin-types'
import details from './DETAILS.md?raw'

export const LOYALTY_ID = 'loyalty'

export const POINTS_PER_CURRENCY_KEY = 'points_per_currency'
export const REDEEM_RATE_KEY = 'redeem_rate'
export const MIN_REDEEM_KEY = 'min_redeem_points'

export const DEFAULT_POINTS_PER_CURRENCY = 1
export const DEFAULT_REDEEM_RATE = 100
export const DEFAULT_MIN_REDEEM = 100

/**
 * The rule a shop can change without opening the plugin's screen.
 *
 * The *tier ladder* is deliberately not here, for the same reason the weighing
 * scale keeps its label layouts out of settings: a ladder is a list of rows
 * with three fields each, and a settings schema that renders text, number,
 * boolean and select would turn it into JSON a shopkeeper has to type correctly.
 * The ladder gets a small editor beside the register it describes.
 */
export const loyaltyManifest: PluginManifest = {
  // Written out rather than referenced, for the same reason the permission keys
  // below are: the shipped bundle is compared with *this file* by reading it.
  id: 'loyalty',
  name: 'Loyalty',
  details,
  version: '1.0.0',
  coreApiVersion: '^1.0.0',
  description:
    'Points, tiers and redemption: what the shop owes its best customers, and money off the sale when they spend it.',
  category: 'optional',
  pricing: {
    plan: 'paid',
    priceBdt: 499,
    trialDays: 14,
  },
  icon: 'card_membership',
  permissions: [
    {
      key: 'loyalty.view',
      label: 'See loyalty accounts',
      group: 'customers',
      description: 'See a customer’s points, their tier, and every movement that made them.',
    },
    {
      key: 'loyalty.redeem',
      label: 'Give points off at the till',
      group: 'customers',
      description:
        'Take a customer’s points off the sale, and hand them back if the sale is abandoned.',
    },
    {
      key: 'loyalty.manage',
      label: 'Adjust points and the rules',
      group: 'customers',
      description:
        'Correct a balance with a reason, and set the earning rule, the redemption rate and the tier ladder.',
    },
  ],
  settingsSchema: [
    {
      key: POINTS_PER_CURRENCY_KEY,
      label: 'Points earned per unit spent',
      type: 'number',
      default: DEFAULT_POINTS_PER_CURRENCY,
      min: 0,
      max: 1000,
      step: 0.1,
      helpText:
        'Points a customer earns for every 1 of the shop’s currency on a completed sale. A sale that earned nothing is still recorded.',
    },
    {
      key: REDEEM_RATE_KEY,
      label: 'Points that equal 1 of currency',
      type: 'number',
      default: DEFAULT_REDEEM_RATE,
      min: 1,
      max: 100000,
      step: 1,
      helpText:
        '100 means a hundred points off for every 1 off the sale — a paisa a point. Changing this changes redemptions from tomorrow, never what a customer already earned.',
    },
    {
      key: MIN_REDEEM_KEY,
      label: 'Smallest redemption, in points',
      type: 'number',
      default: DEFAULT_MIN_REDEEM,
      min: 1,
      max: 1000000,
      step: 1,
      helpText:
        'The till offers money off in steps of this many points, so a customer is never asked to spend an odd remainder.',
    },
  ],
}
