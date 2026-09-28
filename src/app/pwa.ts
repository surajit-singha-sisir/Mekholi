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

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const INSTALLED_KEY = 'mekholi.pwa.installed'
const SNOOZE_KEY = 'mekholi.pwa.install-notice-until'
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

function standalone(windowLike: Window, navigatorLike: Navigator): boolean {
  return (
    windowLike.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigatorLike as Navigator & { standalone?: boolean }).standalone === true
  )
}

function storedNumber(storage: Storage, key: string): number {
  try {
    return Number(storage.getItem(key) ?? 0)
  } catch {
    return 0
  }
}

function store(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
    // Private modes may refuse storage. The notice still works for this page.
  }
}

/**
 * Offer installation without relying on a browser's easy-to-miss address-bar
 * icon. Chromium gets a real one-click install prompt; iOS and browsers that
 * expose no prompt get the exact browser-menu instruction instead.
 */
export function mountPwaInstallNotice(options: {
  window?: Window
  document?: Document
  navigator?: Navigator
  now?: () => number
  fallbackDelayMs?: number
} = {}): () => void {
  const windowLike = options.window ?? window
  const documentLike = options.document ?? document
  const navigatorLike = options.navigator ?? navigator
  const now = options.now ?? Date.now

  if (!windowLike.isSecureContext) return () => {}

  if (standalone(windowLike, navigatorLike)) {
    store(windowLike.localStorage, INSTALLED_KEY, '1')
    return () => {}
  }
  if (storedNumber(windowLike.localStorage, INSTALLED_KEY) === 1) return () => {}
  if (storedNumber(windowLike.localStorage, SNOOZE_KEY) > now()) return () => {}

  let deferred: BeforeInstallPromptEvent | null = null
  let notice: HTMLElement | null = null
  const isIos = /iPad|iPhone|iPod/.test(navigatorLike.userAgent)

  const remove = (): void => {
    notice?.remove()
    notice = null
  }

  const snooze = (): void => {
    store(windowLike.localStorage, SNOOZE_KEY, String(now() + SNOOZE_MS))
    remove()
  }

  const render = (): void => {
    if (notice || standalone(windowLike, navigatorLike)) return

    const title = documentLike.createElement('strong')
    title.className = 'block text-sm font-semibold text-content'
    title.textContent = 'Install Mekholi on this device'

    const detail = documentLike.createElement('span')
    detail.className = 'mt-1 block text-xs leading-5 text-content-muted'
    detail.textContent = deferred
      ? 'Open the POS like an app and keep its application shell available when the connection drops.'
      : isIos
        ? 'In Safari, tap Share, then “Add to Home Screen”.'
        : 'Open your browser menu and choose “Install Mekholi” or “Add to Home screen”.'

    const copy = documentLike.createElement('div')
    copy.className = 'min-w-0 flex-1'
    copy.append(title, detail)

    const actions = documentLike.createElement('div')
    actions.className = 'flex shrink-0 items-center justify-end gap-2'

    if (deferred) {
      const install = documentLike.createElement('button')
      install.type = 'button'
      install.className = 'rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary'
      install.textContent = 'Install'
      install.addEventListener('click', () => {
        const request = deferred
        if (!request) return
        deferred = null
        void request.prompt().then(() => request.userChoice).then((choice) => {
          if (choice.outcome === 'accepted') {
            store(windowLike.localStorage, INSTALLED_KEY, '1')
            remove()
          } else {
            snooze()
          }
        })
      })
      actions.append(install)
    }

    const later = documentLike.createElement('button')
    later.type = 'button'
    later.className = 'rounded-lg px-3 py-2 text-sm font-medium text-content-muted hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary'
    later.textContent = 'Not now'
    later.setAttribute('aria-label', 'Dismiss install notice for seven days')
    later.addEventListener('click', snooze)
    actions.append(later)

    notice = documentLike.createElement('aside')
    notice.id = 'pwa-install-notice'
    notice.className = 'fixed inset-x-4 bottom-4 z-[100] mx-auto flex max-w-2xl flex-col items-stretch gap-3 rounded-xl border border-border bg-surface-elevated p-4 shadow-xl sm:flex-row sm:items-center sm:gap-4'
    notice.setAttribute('role', 'status')
    notice.setAttribute('aria-live', 'polite')
    notice.append(copy, actions)
    documentLike.body.append(notice)
  }

  const beforeInstall = (event: Event): void => {
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    remove()
    render()
  }
  const installed = (): void => {
    store(windowLike.localStorage, INSTALLED_KEY, '1')
    remove()
  }

  windowLike.addEventListener('beforeinstallprompt', beforeInstall)
  windowLike.addEventListener('appinstalled', installed)

  // iOS has no beforeinstallprompt. Other browsers receive a short chance to
  // provide the native event before the menu-based fallback appears.
  const timer = windowLike.setTimeout(render, isIos ? 0 : (options.fallbackDelayMs ?? 3000))

  return () => {
    windowLike.clearTimeout(timer)
    windowLike.removeEventListener('beforeinstallprompt', beforeInstall)
    windowLike.removeEventListener('appinstalled', installed)
    remove()
  }
}
