/**
 * The currency screen.
 *
 * What must hold: the screen leads with the shop's own example (৳1,400 and
 * what it now reads as), picking a target saves at once, a typed rate is a
 * manual rate, and switching off really is off — plus the honesty card
 * that says the books never left the base currency.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { createCurrencyScreen } from './currency-screen'
import type { CurrencyScreenHost } from './index'
import type { MultiCurrencyConfig, RateTable } from './engine'

const table = (rates: Record<string, number>): RateTable => ({
  rates,
  fetchedAt: new Date().toISOString(),
})

function host(initial: Partial<MultiCurrencyConfig> = {}, fresh: RateTable | null = null) {
  let config: MultiCurrencyConfig = {
    target: '',
    mode: 'live',
    manualRate: 0,
    base: 'BDT',
    table: null,
    ...initial,
  }
  const saves: MultiCurrencyConfig[] = []
  const screenHost: CurrencyScreenHost = {
    base: 'BDT',
    config: () => config,
    save: async (next) => {
      config = next
      saves.push(next)
    },
    refresh: async () => fresh,
  }
  return { screenHost, saves, config: () => config }
}

const selects = (root: HTMLElement) => Array.from(root.querySelectorAll('select'))
const rateBox = (root: HTMLElement) => root.querySelector<HTMLInputElement>('input[placeholder="122.50"]')!

describe('currency screen', () => {
  it('says plainly that nothing converts until a currency is picked', () => {
    const { screenHost } = host()
    const root = createCurrencyScreen(screenHost)
    expect(root.textContent).toContain('Showing BDT — no conversion')
    expect(root.textContent).toContain('never converts what is stored'.replace('never', 'Never'))
  })

  it('shows the shop’s example once a rate is live: ৳1,400 → $11.43', () => {
    const { screenHost } = host({ target: 'USD', table: table({ USD: 1, BDT: 122.5 }) })
    const root = createCurrencyScreen(screenHost)
    expect(root.textContent).toContain('BDT ➜ USD')
    expect(root.textContent).toContain('$11.43')
    expect(root.textContent).toContain('1 USD = 122.5 BDT')
  })

  it('saves the moment a target is picked', () => {
    const { screenHost, saves } = host({ table: table({ USD: 1, BDT: 122.5 }) })
    const root = createCurrencyScreen(screenHost)
    const target = selects(root)[0]!
    target.value = 'USD'
    target.dispatchEvent(new Event('change', { bubbles: true }))
    expect(saves.at(-1)?.target).toBe('USD')
    expect(root.textContent).toContain('$11.43')
  })

  it('treats a typed rate as the shopkeeper choosing manual', () => {
    const { screenHost, saves } = host({ target: 'USD', table: table({ USD: 1, BDT: 122.5 }) })
    const root = createCurrencyScreen(screenHost)
    const box = rateBox(root)
    box.value = '১২০' // Bangla keyboard — the digits must still land
    box.dispatchEvent(new Event('change', { bubbles: true }))
    const last = saves.at(-1)!
    expect(last.mode).toBe('manual')
    expect(last.manualRate).toBe(120)
    expect(root.textContent).toContain('1 USD = 120 BDT')
  })

  it('waits honestly when a target exists but no rate does', () => {
    const { screenHost } = host({ target: 'USD', mode: 'manual', manualRate: 0 })
    const root = createCurrencyScreen(screenHost)
    expect(root.textContent).toContain('waiting for a rate')
    expect(root.textContent).toContain('Type your rate below')
  })

  it('turning off goes back to the base currency everywhere', () => {
    const { screenHost, saves } = host({ target: 'USD', table: table({ USD: 1, BDT: 122.5 }) })
    const root = createCurrencyScreen(screenHost)
    const target = selects(root)[0]!
    target.value = ''
    target.dispatchEvent(new Event('change', { bubbles: true }))
    expect(saves.at(-1)?.target).toBe('')
    expect(root.textContent).toContain('Showing BDT — no conversion')
  })

  it('never offers the base currency as a target — converting BDT to BDT is noise', () => {
    const { screenHost } = host()
    const root = createCurrencyScreen(screenHost)
    const options = Array.from(selects(root)[0]!.options).map((option) => option.value)
    expect(options).toContain('USD')
    expect(options.filter((value) => value === 'BDT')).toEqual([])
  })
})
