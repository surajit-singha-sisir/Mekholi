/**
 * Tell the shop when a new build is ready — and let one tap take it.
 *
 * `registerPwa()` keeps the app shell (HTML/JS/CSS) in Cache Storage so the
 * till opens offline. The cost of that is staleness: a freshly deployed build
 * installs as a *waiting* service worker and, on its own, never takes over the
 * open page. The shop keeps running yesterday's bundle until every tab and the
 * installed app are fully closed — which is why a shipped feature (the branch
 * switch splash, say) can be live on the server and still invisible on the
 * counter.
 *
 * This closes that gap. It listens for the `PWA_UPDATE_READY` event the
 * registration raises when a waiting worker appears, shows a persistent toast
 * with a Reload action, and on tap tells the waiting worker to take over. The
 * worker's `clients.claim()` then fires `controllerchange`, and the page
 * reloads once onto the new shell.
 *
 * Everything the DOM/toast/reload needs is injectable so the wiring is unit
 * testable without a live service worker.
 */

import { PWA_UPDATE_READY, activatePwaUpdate } from './pwa'
import { toast } from '../components/feedback/toast'
import { t } from '../shared/i18n'

export interface PwaUpdatePromptOptions {
  windowLike?: Window
  navigatorLike?: Pick<Navigator, 'serviceWorker'>
  /**
   * Show the "update ready" affordance and return a dismisser. Defaults to a
   * persistent toast with a Reload action.
   */
  notify?: (onReload: () => void) => () => void
  /** Reload the page onto the new shell. Defaults to `location.reload()`. */
  reload?: () => void
  /** Post SKIP_WAITING to the waiting worker. Defaults to {@link activatePwaUpdate}. */
  activate?: (registration: ServiceWorkerRegistration) => void
}

/**
 * Wire the update prompt. Call once at boot, after {@link registerPwa}.
 * Returns a teardown that removes the listeners and any open notice.
 */
export function mountPwaUpdatePrompt(options: PwaUpdatePromptOptions = {}): () => void {
  const windowLike =
    options.windowLike ?? (typeof window === 'undefined' ? undefined : window)
  const navigatorLike =
    options.navigatorLike ?? (typeof navigator === 'undefined' ? undefined : navigator)

  if (!windowLike || !navigatorLike?.serviceWorker) return () => {}
  const container = navigatorLike.serviceWorker

  const reload = options.reload ?? ((): void => windowLike.location.reload())
  const activate = options.activate ?? activatePwaUpdate
  const notify = options.notify ?? defaultNotify

  // The worker takes control the instant it activates; reload once onto it.
  let reloading = false
  const onControllerChange = (): void => {
    if (reloading) return
    reloading = true
    reload()
  }
  container.addEventListener('controllerchange', onControllerChange)

  let dismiss: (() => void) | null = null
  const onUpdateReady = (event: Event): void => {
    const registration = (event as CustomEvent<ServiceWorkerRegistration>).detail
    if (!registration) return
    // A second update while a notice is still up: replace it, don't stack.
    dismiss?.()
    dismiss = notify(() => activate(registration))
  }
  windowLike.addEventListener(PWA_UPDATE_READY, onUpdateReady)

  return () => {
    windowLike.removeEventListener(PWA_UPDATE_READY, onUpdateReady)
    container.removeEventListener('controllerchange', onControllerChange)
    dismiss?.()
    dismiss = null
  }
}

function defaultNotify(onReload: () => void): () => void {
  return toast(t('pwa.updateReady.body'), {
    tone: 'info',
    title: t('pwa.updateReady.title'),
    // Persistent: an update notice the cashier never saw is an update never taken.
    timeout: 0,
    action: { label: t('pwa.updateReady.action'), onClick: onReload },
  })
}
