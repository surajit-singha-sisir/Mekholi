/**
 * Due book (বাকির খাতা) — behaviour.
 *
 * One nav entry, one screen, one dashboard tile — all reads. The writes
 * (booking a due at the till, collecting one on the customer card) are
 * core surfaces that light up when this plugin is loaded: the till checks
 * `registry.loadedIds` for 'due-ledger' before offering "keep as due",
 * and the customer card does the same for "collect due". That check is a
 * string, not an import — this file still imports nothing from
 * `src/features/` and nothing from another plugin (spec §51).
 *
 * Data comes through the RPC bridge (`due_ledger_book`, 059), which
 * refuses the calls entirely while the plugin is disabled — so switching
 * the khata off closes the book server-side too, not just the menu.
 */

import { h, srOnly } from '../../components/ui/h'
import { stat } from '../../components/ui/card'
import { formatMoney, minor } from '../../shared/domain/money'
import type { Plugin } from '../../shared/registry/plugin-types'
import { DUE_LEDGER_ID, DUE_VIEW, dueLedgerManifest } from './manifest'

interface DueSummary {
  total_due_minor: number
  debtor_count: number
}

export const dueLedgerPlugin: Plugin = {
  id: DUE_LEDGER_ID,
  name: dueLedgerManifest.name,
  version: dueLedgerManifest.version,
  description: dueLedgerManifest.description,
  ...(dueLedgerManifest.icon ? { icon: dueLedgerManifest.icon } : {}),

  register(api) {
    api.registerNav({
      id: 'due-ledger',
      label: 'Due book',
      icon: 'menu_book',
      section: 'selling',
      route: '/plugins/due-ledger',
      permission: DUE_VIEW,
      order: 35,
    })

    api.registerRoute({
      path: '/plugins/due-ledger',
      title: 'Due book (বাকির খাতা)',
      permission: DUE_VIEW,
      load: async () => {
        const screen = await import('./due-screen')
        return {
          render: (ctx) => screen.createDueScreen({ db: api.db, currency: ctx.currency }),
        }
      },
    })

    api.registerDashboardWidget({
      id: 'due-ledger.summary',
      title: 'Dues',
      size: 'sm',
      permission: DUE_VIEW,
      render: async () => {
        let summary: DueSummary
        try {
          summary = await api.db.rpc<DueSummary>('summary', {})
        } catch (error) {
          return h(
            'p',
            { class: 'text-xs text-content-muted' },
            error instanceof Error ? error.message : 'The due book could not be read just now.'
          )
        }
        const total = formatMoney(minor(summary.total_due_minor), { currency: 'BDT' })
        return h(
          'div',
          { class: 'flex flex-col gap-2' },
          srOnly(`Dues: ${total} owed by ${summary.debtor_count} customer(s)`),
          stat('Owed to the shop', total, {
            iconName: 'menu_book',
            hint:
              summary.debtor_count === 0
                ? 'Nobody owes anything.'
                : `${summary.debtor_count} customer${summary.debtor_count === 1 ? '' : 's'} in the book`,
          })
        )
      },
    })
  },

  // Nothing to release: no timers, no listeners, no state between visits.
  dispose() {},
}
