/**
 * Branch switch splash (docs/13 P1-4, follow-up).
 *
 * Changing the branch from the topbar switcher swaps the whole sales floor —
 * warehouse, register, open session — and every screen re-reads it. That
 * re-resolution takes a round trip, and while it is in flight the screen still
 * shows the *previous* branch's numbers. A cashier who taps "Uttara" and keeps
 * looking at "Gulshan"'s till for a beat has been handed a way to sell against
 * the wrong shop.
 *
 * So a switch is not silent: a full-screen, opaque splash covers the app while
 * the branch loads, names the branch being opened, and only lifts once the
 * floor for the new branch has resolved. It reads the same as the shop-open
 * moment it is — "opening Uttara" — rather than a flicker of stale figures.
 *
 * The overlay is opaque (`bg-surface`, not a scrim) on purpose: the point is
 * that no data from the branch you are leaving is visible for even a frame
 * while the branch you are entering loads.
 */

import { t } from '../../shared/i18n'
import { h, icon } from '../../components/ui/h'

/** Kept on screen at least this long so a fast switch is a deliberate beat, not a flash. */
export const MIN_VISIBLE_MS = 650
/** Fade-out duration before the node is removed. */
export const FADE_MS = 200

export interface BranchSplashHandle {
  el: HTMLElement
  /**
   * Lift the splash. Resolves after the fade completes, and never before the
   * splash has been visible for {@link MIN_VISIBLE_MS} — two half-second
   * flashes in a row read as a bug, so a quick switch is padded to one calm one.
   */
  dismiss: () => Promise<void>
}

export interface ShowBranchSplashOptions {
  /** Where to mount. Defaults to `document.body`. */
  container?: HTMLElement
  /** Injectable clock/scheduler, so the timing is testable without real waits. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => void
}

/**
 * Build the splash element. Pure — no mounting, no timers — so its content and
 * accessibility markup can be asserted without a live shell.
 */
export function buildBranchSplash(branchName: string): HTMLElement {
  const name = branchName.trim()
  const initial = (name.charAt(0) || '?').toUpperCase()

  return h(
    'div',
    {
      // Above the drawer (z-80) and every in-app overlay: a branch switch is
      // modal by nature — nothing else should be reachable mid-swap.
      class:
        'fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 ' +
        'bg-surface px-6 text-center transition-opacity duration-200 animate-fade-in',
      // Announced to assistive tech: a sighted user sees the cover, a screen
      // reader hears "Switching to Uttara".
      role: 'status',
      'aria-live': 'assertive',
      'aria-busy': 'true',
      'data-testid': 'branch-splash',
    },
    // The branch's monogram, with a slow pulse so the cover reads as "working"
    // even before the spinner is noticed.
    h(
      'div',
      {
        class:
          'grid h-20 w-20 place-items-center rounded-2xl bg-primary text-primary-contrast ' +
          'shadow-lg animate-pulse',
      },
      h('span', { class: 'text-3xl font-bold', text: initial })
    ),
    h(
      'div',
      { class: 'flex flex-col items-center gap-1' },
      h('p', {
        class: 'text-xs font-medium uppercase tracking-wide text-content-muted',
        text: t('branch.switching'),
      }),
      h('p', {
        class: 'max-w-xs truncate text-xl font-semibold text-content',
        text: name || t('branch.switching'),
      })
    ),
    // Spinner + caption. The spinner is an inline SVG (no external icon font
    // needed for the one screen the user stares at) so it always renders.
    h(
      'div',
      { class: 'flex items-center gap-2 text-sm text-content-muted' },
      spinner(),
      h('span', { text: t('branch.loadingData') })
    ),
    // A quiet storefront glyph anchors the metaphor: this is a shop opening.
    icon('storefront', 'text-base text-content-subtle')
  )
}

/**
 * Mount a branch-switch splash over the app and hand back a dismisser.
 *
 * The caller does the actual work between show and dismiss:
 *
 * ```ts
 * const splash = showBranchSplash(branch.name)
 * try { await setActiveBranch(branch.id); onNavigate('/') }
 * finally { await splash.dismiss() }
 * ```
 */
export function showBranchSplash(
  branchName: string,
  options: ShowBranchSplashOptions = {}
): BranchSplashHandle {
  const container = options.container ?? document.body
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms))

  const el = buildBranchSplash(branchName)
  const shownAt = now()
  container.appendChild(el)

  const wait = (ms: number): Promise<void> =>
    ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimer(resolve, ms))

  let dismissed = false
  const dismiss = async (): Promise<void> => {
    if (dismissed) return
    dismissed = true
    await wait(MIN_VISIBLE_MS - (now() - shownAt))
    el.classList.add('opacity-0')
    el.setAttribute('aria-busy', 'false')
    await wait(FADE_MS)
    el.remove()
  }

  return { el, dismiss }
}

function spinner(): HTMLElement {
  const wrap = h('span', {
    class: 'inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary',
    'aria-hidden': 'true',
  })
  return wrap
}
