/**
 * Install the web app shell.
 *
 * Product data and pending sales live in the IndexedDB offline layer; the
 * service worker has a deliberately narrower job: keep the versioned HTML,
 * JavaScript, CSS and local icons available when the network disappears.
 * Supabase and every other remote origin are never intercepted or cached.
 */

export const PWA_UPDATE_READY = 'mekholi:pwa-update-ready'
export const PWA_OFFLINE_READY = 'mekholi:pwa-offline-ready'

/**
 * Register after the page has loaded so service-worker startup never competes
 * with the till's first render. `document.baseURI` is the deployment root:
 * Vite sets it at the root and the worker injects it into offline deep links.
 */
export function registerPwa(
  navigatorLike: Pick<Navigator, 'serviceWorker'> | undefined =
    typeof navigator === 'undefined' ? undefined : navigator,
  windowLike: Window | undefined = typeof window === 'undefined' ? undefined : window
): void {
  if (!navigatorLike?.serviceWorker || !windowLike || !windowLike.isSecureContext) return

  const register = (): void => {
    const workerUrl = new URL('sw.js', document.baseURI)
    const scope = new URL('./', document.baseURI).pathname

    void navigatorLike.serviceWorker
      .register(workerUrl, { scope })
      .then((registration) => {
        if (registration.waiting && navigatorLike.serviceWorker.controller) {
          windowLike.dispatchEvent(new CustomEvent(PWA_UPDATE_READY, { detail: registration }))
        }

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            if (installing.state !== 'installed') return
            const event = navigatorLike.serviceWorker.controller
              ? PWA_UPDATE_READY
              : PWA_OFFLINE_READY
            windowLike.dispatchEvent(new CustomEvent(event, { detail: registration }))
          })
        })
      })
      .catch((error: unknown) => {
        // Installation is an enhancement. A browser policy or private mode
        // refusing workers must never stop a cashier from opening the POS.
        console.warn('[mekholi] service worker registration failed:', error)
      })
  }

  if (document.readyState === 'complete') register()
  else windowLike.addEventListener('load', register, { once: true })
}

/** Activate a downloaded update. The caller chooses the safe moment to reload. */
export function activatePwaUpdate(registration: ServiceWorkerRegistration): void {
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
}
