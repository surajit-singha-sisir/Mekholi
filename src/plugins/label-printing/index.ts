/**
 * Label printing — behaviour.
 *
 * The smallest surface a plugin can have: one permission, one nav entry, one
 * screen. No table, no product field, no listener — the SKUs already exist,
 * the printer already exists, and this plugin is only the paper between
 * them. Barcode arithmetic lives in `code128.ts`, the paper in `sheet.ts`,
 * and both are pure so the parts that must not be wrong are the parts a test
 * can hold still.
 *
 * This file imports nothing from `src/features/` and nothing from another
 * plugin. If adding it ever requires editing a feature, the architecture has
 * failed (spec §51).
 */

import type { Plugin } from '../../shared/registry/plugin-types'
import { LABEL_PRINTING_ID, LABELS_PRINT, labelPrintingManifest } from './manifest'

export const labelPrintingPlugin: Plugin = {
  id: LABEL_PRINTING_ID,
  name: labelPrintingManifest.name,
  version: labelPrintingManifest.version,
  description: labelPrintingManifest.description,
  ...(labelPrintingManifest.icon ? { icon: labelPrintingManifest.icon } : {}),

  register(api) {
    for (const permission of labelPrintingManifest.permissions ?? []) {
      api.registerPermission({
        key: permission.key,
        label: permission.label,
        group: permission.group,
        ...(permission.description ? { description: permission.description } : {}),
      })
    }

    api.registerNav({
      id: 'label-printing',
      label: 'Labels',
      icon: 'label',
      section: 'inventory',
      route: '/plugins/label-printing',
      permission: LABELS_PRINT,
      order: 46,
    })

    api.registerRoute({
      path: '/plugins/label-printing',
      title: 'Label printing',
      permission: LABELS_PRINT,
      load: async () => {
        const screen = await import('./labels-screen')
        return screen.createLabelsScreen({ db: api.db })
      },
    })
  },

  // Nothing to release: no timers, no listeners, no state between visits.
  dispose() {},
}
