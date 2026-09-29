/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPullToRefresh } from './pull-to-refresh'

function touch(type: string, x: number, y: number, target: HTMLElement): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    configurable: true,
    value: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  })
  target.dispatchEvent(event)
  return event
}

function fixture(): { parent: HTMLElement; surface: HTMLElement; child: HTMLElement } {
  const parent = document.createElement('div')
  const surface = document.createElement('main')
  const child = document.createElement('div')
  surface.append(child)
  parent.append(surface)
  document.body.append(parent)
  return { parent, surface, child }
}

afterEach(() => document.body.replaceChildren())

describe('pull to refresh', () => {
  it('reloads after a deliberate downward pull from the top', () => {
    const { surface, child } = fixture()
    const refresh = vi.fn()
    let scheduled: (() => void) | null = null
    const pull = installPullToRefresh({
      surface,
      onRefresh: refresh,
      setTimer: (fn) => {
        scheduled = fn
        return 1
      },
    })

    touch('touchstart', 20, 10, child)
    const move = touch('touchmove', 22, 150, child)
    expect(move.defaultPrevented).toBe(true)
    expect(pull.indicator.dataset['pullToRefresh']).toBe('ready')
    expect(pull.indicator.textContent).toContain('Release to refresh')

    touch('touchend', 22, 150, child)
    expect(pull.indicator.dataset['pullToRefresh']).toBe('refreshing')
    expect(refresh).not.toHaveBeenCalled()
    expect(scheduled).not.toBeNull()
    ;(scheduled as unknown as () => void)()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('springs back without refreshing below the release threshold', () => {
    const { surface, child } = fixture()
    const refresh = vi.fn()
    const pull = installPullToRefresh({ surface, onRefresh: refresh })

    touch('touchstart', 20, 10, child)
    touch('touchmove', 20, 60, child)
    expect(pull.indicator.dataset['pullToRefresh']).toBe('pulling')
    touch('touchend', 20, 60, child)

    expect(pull.indicator.dataset['pullToRefresh']).toBe('idle')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not capture horizontal gestures or a surface scrolled down', () => {
    const { surface, child } = fixture()
    const refresh = vi.fn()
    const pull = installPullToRefresh({ surface, onRefresh: refresh })

    touch('touchstart', 10, 10, child)
    const sideways = touch('touchmove', 100, 30, child)
    expect(sideways.defaultPrevented).toBe(false)
    expect(pull.indicator.dataset['pullToRefresh']).toBe('idle')

    surface.scrollTop = 20
    touch('touchstart', 10, 10, child)
    const down = touch('touchmove', 10, 180, child)
    touch('touchend', 10, 180, child)
    expect(down.defaultPrevented).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('lets a nested scroller return to its own top first', () => {
    const { surface, child } = fixture()
    child.scrollTop = 15
    const refresh = vi.fn()
    installPullToRefresh({ surface, onRefresh: refresh })

    touch('touchstart', 10, 10, child)
    const move = touch('touchmove', 10, 180, child)
    touch('touchend', 10, 180, child)

    expect(move.defaultPrevented).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('removes its indicator and listeners when destroyed', () => {
    const { parent, surface, child } = fixture()
    const refresh = vi.fn()
    const pull = installPullToRefresh({ surface, onRefresh: refresh })
    pull.destroy()

    expect(parent.querySelector('[data-pull-to-refresh]')).toBeNull()
    touch('touchstart', 10, 10, child)
    touch('touchmove', 10, 180, child)
    touch('touchend', 10, 180, child)
    expect(refresh).not.toHaveBeenCalled()
  })
})
