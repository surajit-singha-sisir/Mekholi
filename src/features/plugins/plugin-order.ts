/**
 * The order of the plugin shelf.
 *
 * A shopkeeper who has switched things on comes to this screen for the
 * things they switched on — so those sit on top, and the one enabled most
 * recently sits first, because the plugin you just added is the one you
 * came back to find. Everything not yet running keeps the catalogue's
 * name order below, like the shelf of things still in their boxes.
 */

import type { PluginCatalogEntry } from '../../shared/repositories/contracts'

export function pluginShelfOrder(a: PluginCatalogEntry, b: PluginCatalogEntry): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
  if (a.enabled && b.enabled) {
    const at = Date.parse(a.enabledAt ?? '') || 0
    const bt = Date.parse(b.enabledAt ?? '') || 0
    if (at !== bt) return bt - at
  }
  return a.name.localeCompare(b.name)
}
