/**
 * Notifications — behaviour.
 *
 * One header widget (the bell and its strip), one settings screen, one
 * server function reached through the RPC bridge. The bell polls the feed
 * every five minutes and additionally re-asks the moment this device
 * completes a sale or adjusts stock — the two events that can change the
 * answer — so the count is honest without hammering the database.
 *
 * The shop's base currency reaches the bell the only way a plugin may
 * learn it: the settings screen receives it in its page context and
 * writes it into the plugin's own config for the widget to read. Until
 * someone has opened that screen once, the bell formats in taka — the
 * right default for the market this till is built for.
 *
 * This file imports nothing from `src/features/` and nothing from another
 * plugin (spec §51).
 */

import type { Plugin, PluginAPI } from '../../shared/registry/plugin-types'
import { NOTIFICATIONS_ID, NOTIFICATIONS_MANAGE, NOTIFICATIONS_VIEW, notificationsManifest } from './manifest'
import { readPrefs, writePrefs, type NotificationsFeed } from './engine'
import type { HeaderBell } from './header-bell'

const POLL_MS = 5 * 60 * 1000
const SEEN_KEY = 'seen'
const CURRENCY_KEY = 'baseCurrency'

let bell: HeaderBell | null = null
let timer: ReturnType<typeof setInterval> | null = null
let unsubscribes: Array<() => void> = []

export const notificationsPlugin: Plugin = {
  id: NOTIFICATIONS_ID,
  name: notificationsManifest.name,
  version: notificationsManifest.version,
  description: notificationsManifest.description,
  ...(notificationsManifest.icon ? { icon: notificationsManifest.icon } : {}),

  register(api: PluginAPI) {
    api.registerHeaderWidget({
      id: 'notifications-bell',
      permission: NOTIFICATIONS_VIEW,
      order: 10,
      render: async () => {
        const { createHeaderBell } = await import('./header-bell')

        bell?.dispose()
        bell = createHeaderBell({
          prefs: () => readPrefs(api.settings),
          currency: () => api.settings.get<string>(CURRENCY_KEY, 'BDT'),
          fetchFeed: (prefs) =>
            api.db.rpc<NotificationsFeed>('feed', {
              stock: prefs.stock,
              dues: prefs.dues,
              summary: prefs.summary,
              due_floor_minor: prefs.dueFloorMinor,
            }),
          seen: () => api.storage.get<string[]>(SEEN_KEY, []),
          storeSeen: (signatures) => api.storage.set(SEEN_KEY, signatures),
          go: (route) => api.events.emit('ui.navigate', { type: 'ui.navigate', data: { to: route } }),
        })

        if (timer) clearInterval(timer)
        timer = setInterval(() => void bell?.refresh(), POLL_MS)

        for (const off of unsubscribes) off()
        unsubscribes = [
          api.events.on('sale.completed', () => void bell?.refresh()),
          api.events.on('stock.adjusted', () => void bell?.refresh()),
        ]

        return bell.el
      },
    })

    api.registerNav({
      id: 'notifications',
      label: 'Notifications',
      icon: 'notifications',
      section: 'admin',
      route: '/plugins/notifications',
      permission: NOTIFICATIONS_MANAGE,
      order: 58,
    })

    api.registerRoute({
      path: '/plugins/notifications',
      title: 'Notifications',
      permission: NOTIFICATIONS_MANAGE,
      load: async () => {
        const screen = await import('./settings-screen')
        return {
          render: (ctx) => {
            // The one moment a plugin learns the shop's currency — keep it
            // where the bell can read it on every later visit.
            void api.settings.set(CURRENCY_KEY, ctx.currency)
            return screen.createNotificationsSettings({
              currency: ctx.currency,
              prefs: () => readPrefs(api.settings),
              save: async (prefs) => {
                await writePrefs(api.settings, prefs)
                void bell?.refresh()
              },
            })
          },
        }
      },
    })
  },

  dispose() {
    if (timer) clearInterval(timer)
    timer = null
    for (const off of unsubscribes) off()
    unsubscribes = []
    bell?.dispose()
    bell = null
  },
}
