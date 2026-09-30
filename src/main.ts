/**
 * Application bootstrap.
 *
 * Order matters:
 *   1. Environment check — fail loudly and legibly if Supabase is absent.
 *   2. Plugins load before the first render, so the sidebar is already complete.
 *   3. The session is restored, which decides login screen versus shell.
 *   4. The router starts last, because its guards read the session.
 *
 * One router, not two. When signed in, the shell mounts and the router renders
 * into the shell's outlet; when signed out, the login view replaces the whole
 * root and the router is stopped. A second nested router would mean two sets
 * of guards to keep in step.
 */

import './styles/base.css'
import { env } from './app/env'
import { Router, appPath, restoreInitialLocation, routeHref, type Route } from './app/router/router'
import { setNavigator } from './app/router/navigation'
import { appShell, type AppShell } from './features/layout/app-shell'
import { loginView, notConfiguredView } from './features/auth/login-view'
import { dashboardView } from './features/dashboard/dashboard-view'
import { pluginRegistry, declareShippedPlugins, syncPlugins } from './app/plugins'
import { eventBus } from './shared/bus'
import { mountToasts, toastError } from './components/feedback/toast'
import { installShortcuts } from './features/layout/command-palette'
import { bootstrapSession, signOut, needsOnboarding } from './app/platform/auth'
import { consumeAuthCallback } from './app/platform/auth-url'
import { refreshSalesFloor, salesFloor, salesFloorStore, watchOrganization } from './app/state/sales-floor'
import { watchStockAlerts, watchVisibility } from './app/state/stock-alerts'
import { CORE_NAV } from './features/layout/navigation'
import { placeholderView } from './features/layout/placeholder-view'
import { pluginAdminRoutes } from './features/plugins'
import { installRepositories, resetRepositories } from './app/data'
import { startOffline, offlineRuntime } from './app/offline'
import { posRoutes } from './features/pos'
import { productRoutes } from './features/products'
import { catalogueRoutes } from './features/catalogue'
import { stockRoutes } from './features/stock'
import { salesRoutes } from './features/sales'
import { customerRoutes } from './features/customers'
import { supplierRoutes } from './features/suppliers'
import { purchaseRoutes } from './features/purchases'
import { expenseRoutes } from './features/expenses'
import { registerRoutes } from './features/register'
import { auditRoutes } from './features/audit'
import { analyticsRoutes } from './features/analytics'
import { reportRoutes } from './features/reports'
import { onboardingRoutes } from './features/onboarding'
import { settingsRoutes } from './features/settings'
import { userRoutes } from './features/users'
import { roleRoutes } from './features/roles'
import { sessionStore, can } from './app/state/session'
import { applyToDocument as applyLocaleToDocument, onLocaleChange } from './shared/i18n'
import {
  installAutoTranslate,
  onLocaleForAutoTranslate,
} from './shared/i18n/auto-translate'
import { initTheme } from './shared/theme'
import { translateError } from './app/platform/errors'
import { h } from './components/ui/h'
import { button } from './components/ui/button'
import { emptyState } from './components/ui/card'
import { developerShell, type DeveloperShell } from './developer/shell'
import {
  developerOverviewView,
  developerShopsView,
  developerShopView,
  developerPluginsView,
  developerUsersView,
  developerLogsView,
} from './developer/views'
import { controlPlane } from './developer/control-plane'
import { mountPwaInstallNotice, registerPwa } from './app/pwa'
import { mountPwaUpdatePrompt } from './app/pwa-update-prompt'

// Register the versioned app shell without delaying the first till render.
// IndexedDB still owns products and pending sales; the worker owns only the
// executable shell, so authenticated API responses never enter Cache Storage.
registerPwa()
// A deployed build installs as a *waiting* worker and would otherwise never
// reach an open till until every tab is closed. Surface it: a Reload toast the
// moment an update is ready, so a shipped fix is one tap away, not a mystery.
mountPwaUpdatePrompt()
// Do not leave installation hidden behind a browser address-bar icon. The
// notice uses the native prompt where available and exact menu guidance where
// iOS and other browsers do not expose one.
mountPwaInstallNotice()

// `<html lang>` before the first paint, so Bangla picks the right font from
// the very first frame rather than after the shell redraws.
applyLocaleToDocument()
// Light or dark, before the first paint of the shell: the stored preference
// (or the OS setting) has to be on <html> while the first screen is built,
// or the app flashes white and then corrects itself.
initTheme()
// GitHub Pages serves a deep link through public/404.html, which briefly
// returns to the deploy root. Restore the requested History API path before
// auth decides between the login page and a signed-in shell. The router is not
// started for anonymous users, so doing this only in Router.start() was too
// late and made `/developer` appear to forward permanently to `/Mekholi/`.
restoreInitialLocation()

const mountPoint = document.getElementById('app')
if (!mountPoint) throw new Error('#app mount point missing from index.html')
/** Non-null alias: `root` would lose its narrowing inside nested closures. */
const root: HTMLElement = mountPoint

// ── 1. Environment ────────────────────────────────────────────────────────

if (!env.isSupabaseConfigured) {
  root.replaceChildren(notConfiguredView())
  console.warn('[mekholi] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set')
}

// ── 2. Plugins ────────────────────────────────────────────────────────────
// What this bundle ships is declared in `app/plugins.ts`; what this *shop*
// runs is decided by the database and synced in `enterApp`. The alias keeps
// the rest of this file reading as before.
const registry = pluginRegistry

// ── 3. Toasts and shortcuts ───────────────────────────────────────────────

const unmountToasts = mountToasts()

let shell: AppShell | null = null
let devShell: DeveloperShell | null = null

/** Installed in enterApp, released in leaveApp, so a re-login re-subscribes. */
let unwatchOrganization: () => void = () => {}
let unwatchStockAlerts: () => void = () => {}
let unwatchVisibility: () => void = () => {}
/** Re-warms the catalogue whenever the till's warehouse changes. */
let unwatchFloorWarm: () => void = () => {}

const uninstallShortcuts = installShortcuts(registry, [
  { combo: 'ctrl+k', handler: () => shell?.palette.open() },
])

// ── 4. Router ─────────────────────────────────────────────────────────────

/**
 * The router renders routes into this element and the shell mounts this same
 * element. They must be one and the same: handing the router a detached
 * container means every view renders into memory and the page stays blank —
 * which is exactly the bug this comment now prevents. Module-scoped so it
 * survives sign-out/sign-in cycles.
 */
const outlet = h('div', { class: 'h-full' })

/**
 * Every route requires a permission. The guard redirects to the onboarding
 * view when the account exists but has no shop, and to `/forbidden` when the
 * role lacks the key. There is no `/login` route: signing out unmounts the
 * shell and stops the router, which is a clearer state than a route that
 * renders differently depending on the session.
 */
const routes: Route[] = [
  {
    path: '/',
    title: 'Dashboard',
    permission: 'dashboard.view',
    render: () => dashboardView(registry, { onNavigate: (path) => router.navigate(path) }),
  },
  ...posRoutes({ bus: eventBus, registry }),
  ...productRoutes(registry),
  ...catalogueRoutes(),
  ...stockRoutes({ onNavigate: (path) => router.navigate(path) }),
  ...salesRoutes({ registry }),
  ...customerRoutes({
    onNavigate: (path) => router.navigate(path),
    // The khata surfaces follow the plugin (see the due-ledger manifest).
    dueLedger: () => registry.loadedIds.includes('due-ledger'),
  }),
  ...supplierRoutes({ onNavigate: (path) => router.navigate(path) }),
  ...purchaseRoutes(),
  ...expenseRoutes(),
  ...registerRoutes(),
  ...auditRoutes(),
  ...analyticsRoutes(),
  ...reportRoutes(registry),
  ...pluginAdminRoutes(),
  // Plugin screens own `/plugins/<id>…`. One route pair rather than one per
  // plugin: routes are added by the plugin's own `register`, which runs only
  // when the shop has it enabled, so the table cannot be built ahead of time.
  {
    path: '/plugins/:pluginId',
    title: 'Plugin',
    render: (ctx) => renderPluginRoute(ctx.params.pluginId ?? '', ctx.path, ctx.query),
  },
  {
    path: '/plugins/:pluginId/:rest',
    title: 'Plugin',
    render: (ctx) => renderPluginRoute(ctx.params.pluginId ?? '', ctx.path, ctx.query),
  },
  // The hardware screens used to live at these paths. They are plugin screens
  // now, and the router's fallback sends an unknown path to the dashboard —
  // so without these two lines every old bookmark, and every link printed in
  // a note to staff, silently became "the dashboard again".
  ...[
    ['/printer-setup', '/plugins/printer-setup', 'Printer setup'],
    ['/scanner-setup', '/plugins/barcode-scanner', 'Scanner setup'],
  ].map<Route>(([from, to, title]) => ({
    path: from as string,
    title: title as string,
    render: () => {
      router.navigate(to as string, { replace: true })
      return h('div', { class: 'p-6 text-sm text-content-muted', text: 'Taking you there…' })
    },
  })),
  {
    path: '/developer',
    title: 'Platform overview',
    permission: 'developer.dashboard.view',
    render: () => developerOverviewView((path) => router.navigate(path)),
  },
  {
    path: '/developer/shops',
    title: 'Shops',
    permission: 'platform.shops.view',
    render: () => developerShopsView((path) => router.navigate(path)),
  },
  {
    path: '/developer/shops/:shopId',
    title: 'Shop details',
    permission: 'platform.shops.view',
    render: (ctx) => developerShopView(ctx.params.shopId ?? ''),
  },
  {
    path: '/developer/plugins',
    title: 'Plugin catalogue',
    permission: 'platform.plugins.view',
    render: () => developerPluginsView(),
  },
  {
    path: '/developer/users',
    title: 'Users',
    permission: 'platform.users.view',
    render: () => developerUsersView(),
  },
  {
    path: '/developer/logs',
    title: 'Platform logs',
    permission: 'platform.logs.view',
    render: () => developerLogsView(),
  },
  {
    path: '/forbidden',
    title: 'Not permitted',
    render: () =>
      h(
        'div',
        { class: 'p-6' },
        emptyState('You do not have access to that page', {
          description: 'Ask the shop owner to grant your role the permission.',
          iconName: 'lock',
          action: button('Back to dashboard', { variant: 'primary', onClick: () => router.navigate('/') }),
        })
      ),
  },
  ...onboardingRoutes({ onDone: () => router.navigate('/') }),
  ...settingsRoutes(),
  ...userRoutes({ registry }),
  ...roleRoutes(),
]

/**
 * A plugin switched off while the shopkeeper is standing on one of its screens.
 *
 * Leaving them there is the worst of both worlds: the nav item is gone, the
 * plugin is unloaded, and the page in front of them is a corpse that still
 * takes clicks. Re-running the route costs nothing and the screen below
 * explains itself — "this plugin is switched off for this shop".
 *
 * `router.currentContext` rather than `location.pathname`: the app is served
 * from a sub-path on Pages, and the raw pathname carries that prefix.
 */
eventBus.on('plugin.changed', () => {
  const path = router.currentContext?.path
  if (!path?.startsWith('/plugins/')) return
  const stillThere = registry.routes.items.some((entry) => entry.path === path)
  if (!stillThere) router.navigate(path, { replace: true })
})

/**
 * The sanctioned door for navigation from outside the shell — a plugin's
 * header widget, a toast action. The event existed in the vocabulary from
 * the start; this is the core finally answering it. Plugins must not
 * import the router (boundaries §51), and now they never need to.
 */
eventBus.on('ui.navigate', ({ data }) => {
  router.navigate(data.to, { replace: data.replace === true })
})

/**
 * Render whatever plugin screen matches this path.
 *
 * `load()` is awaited here rather than at registration, so the page module is
 * fetched the first time someone opens the screen — and not at all if the
 * plugin is disabled, in which case this explains why.
 */
async function renderPluginRoute(
  pluginId: string,
  path: string,
  query: URLSearchParams
): Promise<HTMLElement> {
  const route = registry.routes.items.find((entry) => entry.path === path)

  if (!route) {
    const registration = registry.list().find((entry) => entry.id === pluginId)
    return placeholderView({
      item: {
        id: pluginId,
        label: registration?.manifest.name ?? pluginId,
        icon: registration?.manifest.icon ?? 'extension',
        permission: 'plugins.view',
        route: path,
      },
      onBack: () => router.navigate('/'),
      note:
        registration?.status === 'disabled'
          ? 'This plugin is switched off for this shop. Turn it on in Settings → Plugins.'
          : registration?.status === 'blocked'
            ? `This plugin cannot run: ${registration.error ?? 'a dependency is missing'}.`
            : registration?.status === 'error'
              ? `This plugin failed to start: ${registration.error ?? 'unknown error'}.`
              : 'This plugin does not install a screen at this address.',
    })
  }

  if (route.permission && !can(route.permission)) {
    return h(
      'div',
      { class: 'p-6' },
      emptyState('You do not have access to that plugin screen', {
        description: 'Ask the shop owner to grant your role the permission.',
        iconName: 'lock',
        action: button('Back to dashboard', {
          variant: 'primary',
          onClick: () => router.navigate('/'),
        }),
      })
    )
  }

  shell?.setTitle(route.title)
  const module = await route.load()
  return module.render({
    params: {},
    query,
    organizationId: sessionStore.state.activeOrganizationId ?? '',
    organizationName:
      sessionStore.state.organizations.find(
        (org) => org.organization_id === sessionStore.state.activeOrganizationId
      )?.name ?? 'Mekholi',
    branchId: salesFloor()?.branchId ?? null,
    currency: sessionStore.state.organizations.find(
      (org) => org.organization_id === sessionStore.state.activeOrganizationId
    )?.currency ?? 'BDT',
  })
}

const hasDeveloperPermission = (required: string | undefined): boolean => {
  if (!required) return true
  const held = new Set(sessionStore.state.developer?.permissions ?? [])
  return held.has('*') || held.has(required) || held.has(`${required.split('.')[0]}.*`)
}

const router = new Router({
  container: outlet,
  fallback: '/',
  guard: (route) => {
    if (sessionStore.state.status !== 'authenticated') return null
    if (route.path.startsWith('/developer')) {
      return sessionStore.state.developer?.enabled === true && hasDeveloperPermission(route.permission)
        ? null
        : '/forbidden'
    }
    if (needsOnboarding()) return route.path === '/onboarding' ? null : '/onboarding'
    if (can(route.permission)) return null
    return '/forbidden'
  },
  onNavigate: (route, ctx) => {
    shell?.setTitle(route.title)
    devShell?.setTitle(route.title)
    // The sidebar highlight follows every navigation — clicks, back/forward,
    // and plugin `ui.navigate` events alike. Without this it froze on
    // whatever screen the app happened to load on.
    shell?.setActivePath(ctx.path)
    devShell?.setActivePath(ctx.path)
  },
  onError: (error, route) => {
    const translated = translateError(error)
    console.error(`[router] ${route.path}`, error)
    toastError(`${route.title}: ${translated.message}`)
  },
})
// Deep code — a failed print, a plugin — can now offer a working link to a
// settings page without every layer in between carrying a router argument.
setNavigator((path) => router.navigate(path))

// Every item the sidebar advertises must lead somewhere. The router silently
// redirects an unknown path to the dashboard, so an unbuilt screen looked
// like a broken menu rather than a screen that does not exist yet. Deriving
// the gap from the route table above means each placeholder disappears on its
// own the moment the real route is registered — there is no list to keep in
// step by hand.
const registered = new Set(routes.map((route) => route.path))
const placeholders: Route[] = CORE_NAV.filter((item) => !registered.has(item.route)).map(
  (item) => ({
    path: item.route,
    title: item.label,
    // exactOptionalPropertyTypes: an absent permission is a different thing
    // from a permission that happens to be undefined.
    ...(item.permission ? { permission: item.permission } : {}),
    render: () => placeholderView({ item, onBack: () => router.navigate('/') }),
  })
)

router.addAll([...routes, ...placeholders])

// ── 5. Shell mount and teardown ───────────────────────────────────────────

function endDeveloperSupport(): void {
  const organizationId = sessionStore.state.activeOrganizationId
  void controlPlane.endSupport().finally(() => {
    window.location.assign(routeHref(organizationId ? `/developer/shops/${organizationId}` : '/developer/shops'))
  })
}

function enterApp(): void {
  const developerMode =
    sessionStore.state.developer?.enabled === true &&
    (appPath().startsWith('/developer') || sessionStore.state.organizations.length === 0)

  if (developerMode) {
    shell = null
    devShell = developerShell({
      outlet,
      onNavigate: (path) => router.navigate(path),
      onSignOut: () => void leaveApp(),
    })
    root.replaceChildren(devShell.el)
    document.body.classList.add('app-locked')
    if (!appPath().startsWith('/developer')) router.navigate('/developer', { replace: true })
    router.start()
    return
  }

  devShell = null
  // Branch, warehouse and register are resolved here rather than lazily by
  // each screen: the POS cannot render a priced product without knowing which
  // stock room to read, and three screens resolving it independently is three
  // chances to show a half-loaded counter.
  //
  // Subscribed here, not in boot(): signing in through the form calls this
  // function directly, and a subscription installed only on the
  // session-already-exists path meant switching shops stopped re-resolving the
  // floor for the rest of that browser session.
  unwatchOrganization()
  unwatchOrganization = watchOrganization()
  void refreshSalesFloor()

  // Plugins are per shop: enabling is a decision this organization made, and
  // it is read after the session resolves the organization. Loading them here
  // rather than at boot is also what keeps a disabled plugin's code out of the
  // browser entirely.
  void syncPlugins()

  // The low-stock badge is ambient: it must be right without the stock screen
  // being open, and on a device that never writes stock of its own — hence the
  // Realtime subscription rather than a refresh-on-my-own-changes.
  unwatchStockAlerts()
  unwatchStockAlerts = watchStockAlerts()

  // A tablet that slept through the afternoon must not wake up showing the
  // count it had at lunchtime.
  unwatchVisibility()
  unwatchVisibility = watchVisibility()

  // Offline last, because it wraps the repositories every screen above will
  // use, and first-to-be-visible because the queue must exist before the first
  // sale is taken. Started, not awaited: a till that has to wait for IndexedDB
  // before it can show the login screen is a till with a new way to be slow.
  void startOffline()
    .then(async (runtime) => {
      installRepositories(runtime.repositories)
      // The catalogue is what makes an offline till usable, so it is fetched
      // in the background rather than on demand: by the time the connection
      // drops, the shop's products are already here. Re-warmed whenever the
      // floor resolves differently, because the warehouse decides which
      // balances the grid shows.
      const warmFor = (warehouseId: string | null): void => {
        if (!warehouseId) return
        void runtime.warm(warehouseId).catch(() => undefined)
      }
      warmFor(salesFloor()?.warehouseId ?? null)
      unwatchFloorWarm = salesFloorStore.select(
        (state) => state.floor?.warehouseId ?? null,
        warmFor
      )
      void refreshSalesFloor()
    })
    .catch((error: unknown) => {
      // The app works without the offline layer — it is an enhancement, and a
      // browser that refuses storage must not cost the shop its till.
      console.warn('[mekholi] offline layer unavailable:', error)
    })

  shell = appShell({
    registry,
    bus: eventBus,
    onNavigate: (path) => router.navigate(path),
    onSignOut: () => void leaveApp(),
    onEndSupport: endDeveloperSupport,
    outlet,
  })

  root.replaceChildren(shell.el)
  // The shell is one viewport tall and scrolls internally; the page must not
  // scroll behind it (see `body.app-locked` in base.css).
  document.body.classList.add('app-locked')
  router.start()
  eventBus.emit('app.ready', { type: 'app.ready', data: undefined })
}

/**
 * Language is applied live.
 *
 * Every label is built at render time from `t()`, so a language change is a
 * redraw, not a reload: the shell is rebuilt (sidebar, section headers, the
 * palette) and the router re-renders the current screen in place. Nobody has
 * to sign out, and nothing in the address bar changes.
 */
onLocaleChange((next) => {
  if (shell) {
    shell = appShell({
      registry,
      bus: eventBus,
      onNavigate: (path) => router.navigate(path),
      onSignOut: () => void leaveApp(),
      onEndSupport: endDeveloperSupport,
      outlet,
    })
    root.replaceChildren(shell.el)
    router.refresh()
  }
  // The catalogue-driven surfaces are back in English after the rebuild above;
  // the translator engine sweeps everything the catalogue does not cover into
  // Bengali (and stands down when switching back to English).
  onLocaleForAutoTranslate(next)
})

async function leaveApp(): Promise<void> {
  router.stop()
  unwatchFloorWarm()
  unwatchFloorWarm = () => {}
  await offlineRuntime()?.stop()
  shell?.el.remove()
  devShell?.el.remove()
  shell = null
  devShell = null
  unwatchOrganization()
  unwatchStockAlerts()
  unwatchVisibility()
  // The next user may be in a different shop with a different plugin set;
  // leaving them loaded would show one shop's screens to another's staff.
  registry.disposeAll()
  resetRepositories()
  await signOut()
  // The login screen is a normal page again: short phones must be able to
  // scroll the form, so the shell's page lock is released with the shell.
  document.body.classList.remove('app-locked')
  root.replaceChildren(loginView({ onAuthenticated: enterApp }))
}

// ── 6. Boot ───────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Plugins are resolved once the shop is known — enabling is per shop, and
  // the "which plugins?" question has no answer before sign-in. `boot` only
  // declares what this bundle ships (above) and reports malformed manifests.
  for (const problem of declareShippedPlugins()) {
    console.error(`[mekholi] plugin manifest rejected — ${problem}`)
  }

  try {
    await bootstrapSession()
  } catch (error) {
    const translated = translateError(error)
    sessionStore.set({ ...sessionStore.state, status: 'error', error: translated.message })
    toastError(translated.message)
  } finally {
    // The Supabase client reads the callback URL as it is constructed — an
    // OAuth session in the fragment, or a PKCE `?code=` — so this has to come
    // *after* `bootstrapSession()` has let it. Anything still in the URL by
    // now is a message from the provider, and it must not stay in the address
    // bar: a fragment holding a live refresh token is a credential in the
    // user's history and in whatever they copy next (docs/14).
    //
    // `finally`, not the happy path: a stale session made `bootstrapSession`
    // throw and the tokens stayed in the URL, which is worse than the error.
    // A token left behind is the one failure this whole path exists to stop.
    const providerError = consumeAuthCallback()
    if (providerError) toastError(`Sign-in was not completed: ${providerError}`)
  }

  if (sessionStore.state.status === 'authenticated' && !env.isSupabaseConfigured) {
    // Cannot happen in practice, but the state machine should not deadlock.
    root.replaceChildren(notConfiguredView())
    return
  }

  if (sessionStore.state.status === 'authenticated') {
    enterApp()
  } else {
    root.replaceChildren(loginView({ onAuthenticated: enterApp }))
  }
}

window.addEventListener('beforeunload', () => {
  uninstallShortcuts()
  unmountToasts()
  registry.disposeAll()
  eventBus.clear()
})

// The translator engine watches the DOM and renders every surface the `t()`
// catalogue does not cover into Bengali when the shop's language is বাংলা.
// Installed before boot so it catches the very first screen the app paints.
installAutoTranslate()

void boot()

// ── Diagnostics ───────────────────────────────────────────────────────────
// Exposed on window so a plugin failure or a permission mismatch can be
// inspected in the console without adding a debug build.

declare global {
  interface Window {
    mekholi?: {
      registry: typeof pluginRegistry
      bus: typeof eventBus
      session: typeof sessionStore
      env: typeof env
      router: Router
    }
  }
}

window.mekholi = { registry, bus: eventBus, session: sessionStore, env, router }
