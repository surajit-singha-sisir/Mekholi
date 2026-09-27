/** Public surface of the customers feature (spec §19). */

import type { Route } from '../../app/router/router'
import { customersView } from './customers-view'

export interface CustomerRoutesOptions {
  onNavigate: (path: string) => void
  /**
   * Whether the shop keeps a due book — true while the due-ledger plugin
   * is loaded. Asked at render time, not wiring time, so toggling the
   * plugin takes effect on the next visit without a reload. The feature
   * checks a boolean, never the plugin itself (spec §51).
   */
  dueLedger?: () => boolean
}

export function customerRoutes(options: CustomerRoutesOptions): Route[] {
  return [
    {
      path: '/customers',
      title: 'Customers',
      permission: 'customers.view',
      render: () =>
        customersView({
          onNavigate: options.onNavigate,
          collectDue: options.dueLedger?.() ?? false,
        }),
    },
  ]
}

export { customersView } from './customers-view'
