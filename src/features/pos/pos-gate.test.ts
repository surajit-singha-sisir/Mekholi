/**
 * POS gate test.
 *
 * The POS cannot render without the sales floor (branch, stock room,
 * register), and the floor is resolved asynchronously at boot. Two ways that
 * goes wrong, both of which shipped:
 *
 *   1. The route renders before the floor is ready and never re-renders —
 *      the shopkeeper stares at an hourglass forever.
 *   2. The floor fails to resolve and the screen still says "loading", so a
 *      real error is presented as patience.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { posView } from './pos-view'
import { salesFloorStore } from '../../app/state/sales-floor'
import { EventBus } from '../../shared/bus'
import { PluginRegistry } from '../../shared/registry/plugin-registry'

const FLOOR = {
  branchId: 'b-1',
  branchName: 'Main Store',
  warehouseId: 'w-1',
  warehouseName: 'Shop Floor',
  registerId: 'r-1',
  registerName: 'Counter 1',
  sessionId: null,
}

function build(): HTMLElement {
  const bus = new EventBus()
  bus.onError = () => undefined
  // The plugin host, empty: these cases are about the gate, and a registry with
  // nothing enabled draws nothing.
  const registry = new PluginRegistry(bus, {
    settings: () => ({
      get: <T,>(_key: string, fallback: T): T => fallback,
      all: () => ({}),
      set: async () => undefined,
    }),
    data: () => ({
      get: async <T,>(_key: string, fallback: T): Promise<T> => fallback,
      set: async () => undefined,
      remove: async () => false,
      keys: async () => [],
    }),
    db: () => ({
      products: async () => [],
      rpc: async <T,>(): Promise<T> => null as T,
    }),
  })
  return posView({ bus, registry })
}

beforeEach(() => {
  salesFloorStore.reset({ status: 'idle', floor: null, branches: [], error: null, generation: 0 })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('pos gate', () => {
  it('shows a loading state, then the POS itself once the floor resolves', () => {
    const el = build()
    expect(el.textContent).toContain('Loading the shop')

    salesFloorStore.set({ status: 'ready', floor: FLOOR })

    // The search field only exists on the real POS screen.
    expect(el.querySelector('input')).not.toBeNull()
    expect(el.textContent).not.toContain('Loading the shop')
  })

  it('shows the actual error, with a retry, when the floor fails', () => {
    const el = build()
    salesFloorStore.set({ status: 'error', error: 'permission denied for table branches' })

    expect(el.textContent).toContain('could not be loaded')
    expect(el.textContent).toContain('permission denied for table branches')
    expect(el.textContent).not.toContain('Loading the shop')
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Try again'))).toBe(true)
  })

  it('renders the POS directly when the floor is already resolved', () => {
    salesFloorStore.set({ status: 'ready', floor: FLOOR })
    const el = build()
    expect(el.querySelector('input')).not.toBeNull()
    expect(el.textContent).not.toContain('Loading the shop')
  })

  it('stops listening once it has rendered the screen', () => {
    const el = build()
    salesFloorStore.set({ status: 'ready', floor: FLOOR })
    const before = el.querySelector('input')

    // A later error must not tear down a POS that is already usable.
    salesFloorStore.set({ status: 'error', error: 'socket closed' })
    expect(el.querySelector('input')).toBe(before)
  })
})
