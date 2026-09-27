/**
 * Bangladesh VAT (মূসক) — behaviour.
 *
 * One nav entry, one screen, nothing persisted server-side: the screen
 * writes the same per-device invoice design that printer-setup writes
 * (`shared/devices/device-config`), and the design keeps working with the
 * plugin off. The plugin is the doorway, not the machinery — which is why
 * disabling it can never un-print a shop's tax invoice.
 *
 * This file imports nothing from `src/features/` and nothing from another
 * plugin (spec §51).
 */

import type { Plugin } from '../../shared/registry/plugin-types'
import { BD_VAT_ID, BD_VAT_MANAGE, bdVatManifest } from './manifest'

export const bdVatPlugin: Plugin = {
  id: BD_VAT_ID,
  name: bdVatManifest.name,
  version: bdVatManifest.version,
  description: bdVatManifest.description,
  ...(bdVatManifest.icon ? { icon: bdVatManifest.icon } : {}),

  register(api) {
    api.registerNav({
      id: 'bd-vat',
      label: 'VAT (Mushak)',
      icon: 'account_balance',
      section: 'admin',
      route: '/plugins/bd-vat',
      permission: BD_VAT_MANAGE,
      order: 56,
    })

    api.registerRoute({
      path: '/plugins/bd-vat',
      title: 'Bangladesh VAT (Mushak)',
      permission: BD_VAT_MANAGE,
      load: async () => {
        const screen = await import('./vat-screen')
        return {
          render: (ctx) => screen.createVatScreen({ shopName: ctx.organizationName }),
        }
      },
    })
  },

  // Nothing to release: no timers, no listeners, no state between visits.
  dispose() {},
}
