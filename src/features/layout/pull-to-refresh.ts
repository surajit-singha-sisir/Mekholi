import { h, icon } from '../../components/ui/h'

const MAX_PULL = 96
const TRIGGER_AT = 64
const DAMPING = 0.55

export interface PullToRefresh {
  indicator: HTMLElement
  destroy(): void
}

/**
 * Restore the mobile browser gesture that the fixed, internally-scrolling app
 * shell cannot receive from Chrome. Only a single-finger downward drag at the
 * very top is captured; ordinary scrolling, horizontal gestures and nested
 * scroll areas keep their native behaviour.
 */
export function installPullToRefresh(options: {
  surface: HTMLElement
  onRefresh: () => void
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (handle: number) => void
}): PullToRefresh {
  const { surface, onRefresh } = options
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle))

  const glyph = icon('refresh', 'text-xl transition-transform')
  const label = h('span', { class: 'sr-only', text: 'Pull down to refresh' })
  const indicator = h(
    'div',
    {
      'data-pull-to-refresh': 'idle',
      class:
        'pointer-events-none fixed left-1/2 top-2 z-[90] grid h-11 w-11 -translate-x-1/2 ' +
        '-translate-y-16 place-items-center rounded-full border border-border bg-surface-raised ' +
        'text-primary opacity-0 shadow-xl transition-[transform,opacity] duration-150',
      role: 'status',
      'aria-live': 'polite',
    },
    glyph,
    label
  )
  surface.parentElement?.append(indicator)

  let tracking = false
  let startX = 0
  let startY = 0
  let pull = 0
  let refreshTimer: number | null = null

  const reset = (): void => {
    tracking = false
    pull = 0
    indicator.dataset['pullToRefresh'] = 'idle'
    indicator.style.transform = ''
    indicator.style.opacity = ''
    glyph.style.transform = ''
    label.textContent = 'Pull down to refresh'
  }

  const touchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1 || surface.scrollTop > 0) return
    if (hasScrolledAncestor(event.target, surface)) return
    const touch = event.touches[0]
    if (!touch) return
    tracking = true
    startX = touch.clientX
    startY = touch.clientY
    pull = 0
  }

  const touchMove = (event: TouchEvent): void => {
    if (!tracking || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (!touch) return
    const dy = touch.clientY - startY
    const dx = touch.clientX - startX

    if (dy <= 0 || Math.abs(dx) > dy) {
      reset()
      return
    }
    if (surface.scrollTop > 0) {
      reset()
      return
    }

    // Once the intent is clearly a downward pull, own the gesture. Before
    // that threshold Chrome still gets normal taps and tiny finger movement.
    if (dy > 6) event.preventDefault()
    pull = Math.min(MAX_PULL, dy * DAMPING)
    const armed = pull >= TRIGGER_AT
    indicator.dataset['pullToRefresh'] = armed ? 'ready' : 'pulling'
    indicator.style.transform = `translate(-50%, ${Math.round(pull)}px)`
    indicator.style.opacity = String(Math.min(1, pull / 24))
    glyph.style.transform = `rotate(${Math.round(pull * 3.5)}deg)`
    label.textContent = armed ? 'Release to refresh' : 'Pull down to refresh'
  }

  const touchEnd = (): void => {
    if (!tracking) return
    const shouldRefresh = pull >= TRIGGER_AT
    tracking = false

    if (!shouldRefresh) {
      reset()
      return
    }

    indicator.dataset['pullToRefresh'] = 'refreshing'
    indicator.style.transform = 'translate(-50%, 64px)'
    indicator.style.opacity = '1'
    glyph.classList.add('animate-spin')
    label.textContent = 'Refreshing'
    refreshTimer = setTimer(onRefresh, 120)
  }

  const touchCancel = (): void => reset()

  surface.addEventListener('touchstart', touchStart, { passive: true })
  surface.addEventListener('touchmove', touchMove, { passive: false })
  surface.addEventListener('touchend', touchEnd, { passive: true })
  surface.addEventListener('touchcancel', touchCancel, { passive: true })

  return {
    indicator,
    destroy() {
      surface.removeEventListener('touchstart', touchStart)
      surface.removeEventListener('touchmove', touchMove)
      surface.removeEventListener('touchend', touchEnd)
      surface.removeEventListener('touchcancel', touchCancel)
      if (refreshTimer !== null) clearTimer(refreshTimer)
      indicator.remove()
    },
  }
}

/** A nested list that is not at its top must finish scrolling before refresh. */
function hasScrolledAncestor(target: EventTarget | null, surface: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null
  while (node && node !== surface) {
    if (node.scrollTop > 0) return true
    node = node.parentElement
  }
  return false
}
