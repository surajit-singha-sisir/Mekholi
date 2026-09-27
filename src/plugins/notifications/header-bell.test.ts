/**
 * The bell and the strip.
 *
 * What must hold: the count counts only the unread, the strip carries the
 * single most urgent unread item and no other, dismissing acknowledges on
 * this device only (the host is told, nothing else), "mark all as read"
 * quiets everything, and a feed failure keeps the last honest answer
 * instead of emptying the bell.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { createHeaderBell, type BellHost } from './header-bell'
import { DEFAULT_PREFS, type NotificationsFeed } from './engine'

const FEED: NotificationsFeed = {
  stock: { out_count: 1, out_names: ['Soap'], low_count: 0, low_names: [] },
  summary: { sale_count: 4, total_minor: 120000 },
}

function makeHost(feed: NotificationsFeed | (() => Promise<NotificationsFeed>)) {
  let seen: string[] = []
  const gone: string[] = []
  const host: BellHost = {
    prefs: () => DEFAULT_PREFS,
    currency: () => 'BDT',
    fetchFeed: typeof feed === 'function' ? feed : async () => feed,
    seen: () => seen,
    storeSeen: (signatures) => {
      seen = signatures
    },
    go: (route) => gone.push(route),
  }
  return { host, gone, seenNow: () => seen }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const badge = (el: HTMLElement) => el.querySelector('span.pointer-events-none') as HTMLElement
const strip = (el: HTMLElement) => el.querySelector('div.absolute.inset-x-0') as HTMLElement

describe('header bell', () => {
  it('counts the unread and features the most urgent on the strip', async () => {
    const { host } = makeHost(FEED)
    const bell = createHeaderBell(host)
    await flush()

    expect(badge(bell.el).textContent).toBe('2')
    expect(strip(bell.el).classList.contains('hidden')).toBe(false)
    expect(strip(bell.el).textContent).toContain('out of stock')
    expect(strip(bell.el).textContent).not.toContain('Today so far')
    bell.dispose()
  })

  it('dismissing the strip quiets that item and lowers the count', async () => {
    const { host } = makeHost(FEED)
    const bell = createHeaderBell(host)
    await flush()

    strip(bell.el).querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click()
    expect(strip(bell.el).classList.contains('hidden')).toBe(true)
    expect(badge(bell.el).textContent).toBe('1')
    bell.dispose()
  })

  it('“mark all as read” hushes the whole bell', async () => {
    const { host } = makeHost(FEED)
    const bell = createHeaderBell(host)
    await flush()

    bell.el.querySelector<HTMLButtonElement>('button[aria-label="Notifications"]')!.click()
    const markAll = Array.from(bell.el.querySelectorAll('button')).find((b) => b.textContent === 'Mark all as read')!
    markAll.click()

    expect(badge(bell.el).classList.contains('hidden')).toBe(true)
    expect(strip(bell.el).classList.contains('hidden')).toBe(true)
    bell.dispose()
  })

  it('tapping an item acknowledges it and asks the host to navigate', async () => {
    const { host, gone } = makeHost(FEED)
    const bell = createHeaderBell(host)
    await flush()

    bell.el.querySelector<HTMLButtonElement>('button[aria-label="Notifications"]')!.click()
    const first = bell.el.querySelector<HTMLButtonElement>('div.max-h-\\[60vh\\] button')!
    first.click()

    expect(gone).toEqual(['/stock'])
    expect(badge(bell.el).textContent).toBe('1')
    bell.dispose()
  })

  it('keeps the last honest answer when the feed fails', async () => {
    let fail = false
    const { host } = makeHost(async () => {
      if (fail) throw new Error('offline')
      return FEED
    })
    const bell = createHeaderBell(host)
    await flush()
    expect(badge(bell.el).textContent).toBe('2')

    fail = true
    await bell.refresh()
    expect(badge(bell.el).textContent).toBe('2')
    bell.dispose()
  })
})
