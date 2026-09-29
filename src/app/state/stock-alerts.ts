/**
 * Low-stock alerts (Phase 3): the number behind the sidebar badge.
 *
 * A shopkeeper should know stock is running out without opening the stock
 * screen. That makes this a piece of *shared* state rather than something the
 * stock screen owns: the sidebar badge, the dashboard card and the stock
 * screen all read the same count, and any of them can ask for a refresh after
 * a write.
 *
 * ── Why a subscription as well as a refresh ──────────────────────────────
 * The badge has to be right on two screens: the one doing the selling, and the
 * tablet by the door showing the dashboard. The second one never fires a write
 * of its own, so it would never refresh — hence the Realtime channel on
 * `stock_balances` (migration 024 adds it to the publication; RLS still
 * decides which rows a client is told about). Realtime is best-effort by
 * design: if the channel fails, the badge is simply refreshed on the events
 * this client already knows about, and nothing else breaks.
 */

import { Store } from './store'
import { sessionStore } from './session'
import { salesFloor } from './sales-floor'
import { getSupabase } from '../platform/supabase'
import { getRepositories } from '../data'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface StockAlertState {
  lowStock: number
  outOfStock: number
  /** Set when the last attempt failed, so the UI can stay quiet about it. */
  error: string | null
  loaded: boolean
}

export const stockAlertStore = new Store<StockAlertState>({
  lowStock: 0,
  outOfStock: 0,
  error: null,
  loaded: false,
})

let inflight: Promise<void> | null = null

/** Re-read the counts. Safe to call often; concurrent calls share one request. */
export function refreshStockAlerts(): Promise<void> {
  const organization = sessionStore.state.activeOrganizationId
  if (!organization) {
    stockAlertStore.set({ lowStock: 0, outOfStock: 0, error: null, loaded: false })
    return Promise.resolve()
  }

  if (inflight) return inflight

  inflight = (async () => {
    try {
      // Branch-scoped: the badge warns about the till's own selling floor, not
      // stock that is low in a different branch. Falls back to the shop-wide
      // count only before a floor has resolved.
      const warehouseId = salesFloor()?.warehouseId ?? null
      const summary = await getRepositories().stock.summary(
        warehouseId ? { warehouseIds: [warehouseId] } : undefined
      )
      stockAlertStore.set({
        lowStock: summary.lowStock,
        outOfStock: summary.outOfStock,
        error: null,
        loaded: true,
      })
    } catch (error) {
      // A failed count is not worth a toast: the badge is an ambient hint and
      // an error message about it would interrupt a sale. It just goes quiet.
      stockAlertStore.set({
        error: error instanceof Error ? error.message : String(error),
        loaded: false,
      })
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** The badge reads this synchronously on every sidebar render. */
export function lowStockCount(): number {
  return stockAlertStore.state.lowStock
}

let channel: RealtimeChannel | null = null

/**
 * Watch this shop's balances.
 *
 * Returns a teardown function. Called from `enterApp` and released in
 * `leaveApp`, so a sign-out cannot leave a socket subscribed to the previous
 * shop's rows.
 */
export function watchStockAlerts(): () => void {
  const supabase = getSupabase()
  const organization = sessionStore.state.activeOrganizationId

  void refreshStockAlerts()

  if (!supabase || !organization) return () => undefined

  // One channel per organization. `stock_balances` was added to the realtime
  // publication in migration 024; on a project where that publication is
  // absent this subscription simply never fires.
  channel = supabase
    .channel(`stock-alerts:${organization}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'stock_balances',
        filter: `organization_id=eq.${organization}`,
      },
      () => void refreshStockAlerts()
    )
    .subscribe()

  return () => {
    if (channel) {
      void supabase.removeChannel(channel)
      channel = null
    }
  }
}

/** Refresh when the tab becomes visible again — the cheap half of realtime. */
export function watchVisibility(): () => void {
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void refreshStockAlerts()
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => document.removeEventListener('visibilitychange', onVisible)
}
