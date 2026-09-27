/**
 * Branches — behaviour.
 *
 * Four registrations, one idea: the head office can see its branches.
 *
 *   * A screen (admin → Branches): the list, the activity, and the
 *     open-a-branch dialog.
 *   * A dashboard widget: every branch's today, on the one screen the
 *     owner opens every morning.
 *   * A report ("Sales by branch"): the same facts in the reports
 *     library, exportable like every other report.
 *   * The branch switcher in the app shell lights up while this plugin
 *     is loaded — a string check on `registry.loadedIds` over there, not
 *     an import (spec §51).
 *
 * Data comes through the RPC bridge (`branch_list` / `branch_save`, 060),
 * which refuses the calls while the plugin is disabled or unlicensed.
 */

import { h, srOnly } from '../../components/ui/h'
import { formatMoney, minor } from '../../shared/domain/money'
import type { Plugin } from '../../shared/registry/plugin-types'
import { BRANCH_ID, BRANCH_WATCH, branchManifest } from './manifest'
import type { BranchActivity } from './branches-screen'

export const branchPlugin: Plugin = {
  id: BRANCH_ID,
  name: branchManifest.name,
  version: branchManifest.version,
  description: branchManifest.description,
  ...(branchManifest.icon ? { icon: branchManifest.icon } : {}),

  register(api) {
    api.registerNav({
      id: 'branch',
      label: 'Branches',
      icon: 'store',
      section: 'admin',
      route: '/plugins/branch',
      permission: BRANCH_WATCH,
      order: 22,
    })

    api.registerRoute({
      path: '/plugins/branch',
      title: 'Branches',
      permission: BRANCH_WATCH,
      load: async () => {
        const screen = await import('./branches-screen')
        return {
          render: (ctx) => screen.createBranchesScreen({ db: api.db, currency: ctx.currency }),
        }
      },
    })

    api.registerDashboardWidget({
      id: 'branch.today',
      title: 'Branches',
      size: 'wide',
      permission: BRANCH_WATCH,
      render: async () => {
        let branches: BranchActivity[]
        try {
          branches = await api.db.rpc<BranchActivity[]>('list', {})
        } catch (error) {
          return h(
            'p',
            { class: 'text-xs text-content-muted' },
            error instanceof Error ? error.message : 'The branches could not be read just now.'
          )
        }
        return h(
          'div',
          { class: 'flex flex-col' },
          srOnly(`${branches.length} branch(es)`),
          ...branches.map((branch) =>
            h(
              'div',
              { class: 'flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0' },
              h(
                'p',
                { class: 'min-w-0 truncate text-sm text-content' },
                branch.name,
                branch.is_primary ? h('span', { class: 'ml-1 text-xs text-content-muted', text: '· main' }) : null
              ),
              h('p', {
                class: 'shrink-0 text-sm tabular-nums text-content',
                text: `${formatMoney(minor(branch.today_total_minor), { currency: 'BDT' })} · ${branch.today_sales} sale${branch.today_sales === 1 ? '' : 's'} today`,
              })
            )
          )
        )
      },
    })

    api.registerReport({
      id: 'sales-by-branch',
      label: 'Sales by branch',
      icon: 'store',
      group: 'Sales',
      permission: BRANCH_WATCH,
      description: 'Every branch side by side: sales and takings today and over the last 7 days, and the dues still out.',
      filters: { window: false, search: false },
      run: async () => {
        const branches = await api.db.rpc<BranchActivity[]>('list', {})
        return {
          columns: [
            { key: 'branch', label: 'Branch', type: 'text' as const },
            { key: 'today_sales', label: 'Sales today', type: 'int' as const, align: 'right' as const },
            { key: 'today_total', label: 'Takings today', type: 'money' as const, align: 'right' as const },
            { key: 'week_sales', label: 'Sales, 7 days', type: 'int' as const, align: 'right' as const },
            { key: 'week_total', label: 'Takings, 7 days', type: 'money' as const, align: 'right' as const },
            { key: 'dues', label: 'Dues out', type: 'money' as const, align: 'right' as const },
          ],
          rows: branches.map((branch) => ({
            branch: branch.is_primary ? `${branch.name} (main)` : branch.name,
            today_sales: branch.today_sales,
            today_total: branch.today_total_minor,
            week_sales: branch.week_sales,
            week_total: branch.week_total_minor,
            dues: branch.open_dues_minor,
          })),
          totals: {
            today_total: branches.reduce((sum, b) => sum + b.today_total_minor, 0),
            week_total: branches.reduce((sum, b) => sum + b.week_total_minor, 0),
            dues: branches.reduce((sum, b) => sum + b.open_dues_minor, 0),
          },
        }
      },
    })
  },

  // Nothing to release: no timers, no listeners, no state between visits.
  dispose() {},
}
