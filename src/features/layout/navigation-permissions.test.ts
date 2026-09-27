/**
 * The sidebar must equal the rules — for every role, not just the owner.
 *
 * These permission sets are copied from the seeded system roles (the same
 * grants verified against the live database). What must hold: each role
 * sees exactly the menus its permissions unlock, no menu a role holds a
 * permission for is ever hidden, and no menu leaks to a role without one.
 * A manager reported "no Dashboard" once; this test is why it can never
 * be a silent regression again.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PluginRegistry } from '../../shared/registry/plugin-registry'
import { EventBus } from '../../shared/bus/event-bus'
import { buildNavigation } from './navigation'
import { sessionStore, EMPTY_SESSION } from '../../app/state/session'

/** Seeded grants, as verified live (roles → permissions, 003/seeds). */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ['*'],
  manager: [
    'analytics.view', 'customers.create', 'customers.edit', 'customers.view', 'dashboard.view',
    'expenses.create', 'expenses.edit', 'expenses.view', 'inventory.adjust', 'inventory.count',
    'inventory.stock_in', 'inventory.stock_out', 'inventory.transfer', 'inventory.view',
    'products.create', 'products.edit', 'products.price_change', 'products.view',
    'purchases.create', 'purchases.receive', 'purchases.view', 'register.adjust_cash',
    'register.close', 'register.open', 'reports.view', 'sales.cancel', 'sales.create',
    'sales.discount', 'sales.hold', 'sales.refund', 'sales.resume', 'sales.view',
    'suppliers.create', 'suppliers.delete', 'suppliers.edit', 'suppliers.view',
  ],
  cashier: [
    'customers.create', 'customers.view', 'dashboard.view', 'inventory.view', 'products.view',
    'register.close', 'register.open', 'sales.create', 'sales.hold', 'sales.resume', 'sales.view',
  ],
  accountant: [
    'analytics.view', 'dashboard.view', 'expenses.create', 'expenses.delete', 'expenses.edit',
    'expenses.view', 'purchases.view', 'reports.export', 'reports.view',
    // 065: sales.view was missing from the seed — the accountant held the
    // stronger cross-branch grant while the Sales screen stayed hidden.
    'sales.view', 'sales.view_all_branches',
  ],
}

function signInWith(permissions: string[]): void {
  sessionStore.reset({
    ...EMPTY_SESSION,
    status: 'authenticated',
    userId: 'u-1',
    email: 'staff@shop.test',
    organizations: [
      {
        organization_id: 'org-1',
        name: 'Test Shop',
        slug: 'test-shop',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        role_names: ['Staff'],
        role_keys: ['staff'],
        shop_type: 'grocery',
        is_owner: false,
        permissions,
      },
    ],
    activeOrganizationId: 'org-1',
    permissions,
  })
}

function visibleIds(): string[] {
  return buildNavigation(new PluginRegistry(new EventBus())).flatMap((group) =>
    group.items.map((item) => item.id)
  )
}

beforeEach(() => {
  sessionStore.reset({ ...EMPTY_SESSION })
})

describe('sidebar equals the rules', () => {
  it('a manager sees the floor, the books and the registers — not administration', () => {
    signInWith(ROLE_PERMISSIONS['manager']!)
    const ids = visibleIds()
    for (const id of [
      'dashboard', 'pos', 'sales', 'customers', 'products', 'catalogue', 'stock',
      'suppliers', 'purchases', 'expenses', 'reports', 'analytics', 'register',
    ]) {
      expect(ids, `manager should see ${id}`).toContain(id)
    }
    for (const id of ['users', 'roles', 'plugins', 'audit', 'settings']) {
      expect(ids, `manager should NOT see ${id}`).not.toContain(id)
    }
  })

  it('a cashier sees the till and the till only, plus their dashboard', () => {
    signInWith(ROLE_PERMISSIONS['cashier']!)
    const ids = visibleIds()
    for (const id of ['dashboard', 'pos', 'sales', 'customers', 'products', 'catalogue', 'stock', 'register']) {
      expect(ids, `cashier should see ${id}`).toContain(id)
    }
    for (const id of ['suppliers', 'purchases', 'expenses', 'reports', 'analytics', 'users', 'roles', 'plugins', 'audit', 'settings']) {
      expect(ids, `cashier should NOT see ${id}`).not.toContain(id)
    }
  })

  it('an accountant sees the numbers, not the shelves', () => {
    signInWith(ROLE_PERMISSIONS['accountant']!)
    const ids = visibleIds()
    for (const id of ['dashboard', 'expenses', 'purchases', 'reports', 'analytics', 'sales']) {
      expect(ids, `accountant should see ${id}`).toContain(id)
    }
    for (const id of ['pos', 'stock', 'users', 'plugins', 'settings', 'register']) {
      expect(ids, `accountant should NOT see ${id}`).not.toContain(id)
    }
  })

  it('the owner wildcard opens every core menu', () => {
    signInWith(ROLE_PERMISSIONS['owner']!)
    const ids = visibleIds()
    for (const id of ['dashboard', 'pos', 'users', 'roles', 'plugins', 'audit', 'settings']) {
      expect(ids).toContain(id)
    }
  })

  it('no permissions means no menus — never a crash', () => {
    signInWith([])
    expect(visibleIds()).toEqual([])
  })
})
