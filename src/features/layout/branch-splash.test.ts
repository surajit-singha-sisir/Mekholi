/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest'
import { buildBranchSplash, showBranchSplash, MIN_VISIBLE_MS, FADE_MS } from './branch-splash'

afterEach(() => document.body.replaceChildren())

describe('branch splash', () => {
  it('names the branch being opened', () => {
    const el = buildBranchSplash('Uttara')
    expect(el.textContent).toContain('Uttara')
    // The monogram is the branch initial.
    expect(el.textContent).toContain('U')
  })

  it('announces itself to assistive tech as a busy status', () => {
    const el = buildBranchSplash('Gulshan')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('assertive')
    expect(el.getAttribute('aria-busy')).toBe('true')
  })

  it('is an opaque cover, not a translucent scrim', () => {
    // The class carries `bg-surface` (opaque) rather than `bg-black/40`, so no
    // frame of the branch being left shows through while the new one loads.
    const el = buildBranchSplash('Dhanmondi')
    expect(el.className).toContain('bg-surface')
    expect(el.className).not.toContain('bg-black/')
    expect(el.className).toContain('fixed')
    expect(el.className).toContain('inset-0')
  })

  it('falls back to a placeholder monogram for an empty name', () => {
    const el = buildBranchSplash('   ')
    expect(el.textContent).toContain('?')
  })

  it('mounts on show and removes on dismiss', async () => {
    const container = document.createElement('div')
    document.body.append(container)

    // A controllable clock: dismiss should honour the minimum visible time and
    // the fade without any real waiting.
    let clock = 1_000
    const timers: Array<{ fn: () => void; at: number }> = []
    const splash = showBranchSplash('Banani', {
      container,
      now: () => clock,
      setTimer: (fn, ms) => {
        timers.push({ fn, at: clock + ms })
      },
    })

    expect(container.querySelector('[data-testid="branch-splash"]')).not.toBeNull()

    // Dismissed immediately (elapsed 0): the min-visible wait and then the fade
    // wait are scheduled one after the other. Drain them in clock order,
    // yielding to microtasks each pass so dismiss can schedule the next timer
    // before we fire it.
    const done = splash.dismiss()
    for (let guard = 0; guard < 20; guard += 1) {
      await Promise.resolve()
      const next = timers.shift()
      if (!next) break
      clock = Math.max(clock, next.at)
      next.fn()
    }
    await done

    expect(container.querySelector('[data-testid="branch-splash"]')).toBeNull()
    // Sanity: the constants exist and are sane.
    expect(MIN_VISIBLE_MS).toBeGreaterThan(0)
    expect(FADE_MS).toBeGreaterThan(0)
  })

  it('dismiss is idempotent', async () => {
    const splash = showBranchSplash('Mirpur', {
      now: () => 10_000, // always "long past" min-visible, so no scheduled wait
      setTimer: (fn) => fn(),
    })
    await splash.dismiss()
    await splash.dismiss()
    expect(document.querySelector('[data-testid="branch-splash"]')).toBeNull()
  })
})
