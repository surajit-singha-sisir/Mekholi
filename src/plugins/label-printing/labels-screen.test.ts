/**
 * The screen-level money contract.
 *
 * `plugin_products` sends prices in MINOR units (migration 048). This screen
 * once multiplied by 100 on top of that, so a ৳250.00 bottle of oil wore a
 * ৳25,000.00 shelf label — noticed by the shopkeeper, not by a test. Now it
 * is noticed by a test.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { createLabelsScreen } from './labels-screen'
import type { PluginPageContext, ProductSnapshot } from '../../shared/registry/plugin-types'

const oil: ProductSnapshot = {
  id: 'p-1',
  name: 'Extra Virgin Olive Oil - 100ml',
  sku: 'EXT-0005',
  // ৳250.00, as the bridge really sends it: 25,000 paisa.
  price: 25_000,
  track_stock: true,
  is_active: true,
  reorder_point: null,
  metadata: {},
}

const ctx: PluginPageContext = {
  params: {},
  query: new URLSearchParams(),
  organizationId: 'org-1',
  organizationName: 'Sisir Enterprise',
  branchId: null,
  currency: 'BDT',
}

describe('labels screen money', () => {
  it('shows the price the shelf knows, not a hundred times it', async () => {
    const screen = createLabelsScreen({
      db: {
        products: async () => [oil],
        rpc: async <T,>(): Promise<T> => null as T,
      },
    })
    const view = await screen.render(ctx)
    document.body.append(view)

    const text = view.textContent ?? ''
    expect(text).toContain('Extra Virgin Olive Oil')
    expect(text).toContain('250.00')
    expect(text).not.toContain('25,000.00')
  })
})
