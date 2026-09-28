/**
 * History API router with permission guards.
 *
 * The deployed app is a static GitHub Pages site, so `public/404.html` sends
 * direct deep links back to the application entry point. Navigation itself
 * stays on real paths: links are copyable, browser back/forward works, and a
 * legacy `#/settings` URL is migrated once rather than becoming a second
 * routing system.
 */

export interface RouteContext {
  /** Named path parameters: `/products/:id` → `{ id: '…' }`. */
  params: Record<string, string>
  query: URLSearchParams
  path: string
}

export interface Route {
  /** `/pos`, `/products/:id`, `/plugins/:id/settings` */
  path: string
  title: string
  /** Permission key required to enter. Omit for public routes (e.g. login). */
  permission?: string
  render: (ctx: RouteContext) => HTMLElement | Promise<HTMLElement>
  /** Called when leaving the route. Return false to cancel navigation. */
  beforeLeave?: () => boolean | Promise<boolean>
}

export interface RouterOptions {
  container: HTMLElement
  fallback?: string
  /** Return a path to redirect to, or null to allow. */
  guard?: (route: Route) => string | null | Promise<string | null>
  onNavigate?: (route: Route, ctx: RouteContext) => void
  onError?: (error: unknown, route: Route) => void
}

interface CompiledRoute {
  route: Route
  matcher: RegExp
  paramNames: string[]
}

/**
 * Work out where the app is deployed, from facts that do not move.
 *
 * The bundle is built with Vite's `base: './'` so it can be served from any
 * sub-path. That makes `BASE_URL` a *relative* string, and resolving it
 * against `window.location.href` resolves it against **the route the user is
 * currently on** — which is not a constant. On the deploy root it gave the
 * right answer, so this looked fine for a year:
 *
 *     /Mekholi/                        → base /Mekholi/        ✓
 *     /Mekholi/plugins/printer-setup   → base /Mekholi/plugins/ ✗
 *
 * From that second URL every link gained a segment — `/Mekholi/plugins/` +
 * `/plugins/barcode-scanner` = `/Mekholi/plugins/plugins/barcode-scanner` —
 * and every path was parsed one segment short, so `/plugins/printer-setup`
 * read as `/printer-setup`, matched nothing, and fell through the router's
 * fallback to the dashboard. Two symptoms, one cause. Any two-segment route
 * would have done it; plugin screens are simply where we have most of them.
 *
 * The fix is to stop asking a question whose answer depends on where you are
 * standing:
 *
 *   * an **absolute** `BASE_URL` ('/', '/Mekholi/') is already the answer —
 *     that is the dev server and any explicitly-configured deployment;
 *   * a **relative** one is resolved against this module's own URL instead.
 *     In a build this file lives at `<root>/assets/index-xxxx.js`, and the
 *     asset directory is a build constant rather than a user's position.
 *
 * Whatever comes out must still be a prefix of the current path; if it is
 * not, we are somewhere unforeseen and the site root is the safe answer.
 *
 * Exported pure so it can be tested against real deployment shapes without a
 * browser — the original bug was invisible at the root path, which is the
 * only path a naive test would try.
 */
export function resolveBasePath(options: {
  baseUrl: string
  moduleUrl: string
  locationHref: string
}): string {
  const { baseUrl, moduleUrl, locationHref } = options
  const pathname = new URL(locationHref).pathname

  const tidy = (value: string): string => {
    const withSlash = value.endsWith('/') ? value : `${value}/`
    return withSlash === '//' ? '/' : withSlash
  }

  if (baseUrl.startsWith('/')) return tidy(baseUrl)

  let derived = '/'
  try {
    // `<root>/assets/index-abc.js` → `<root>/assets/` → `<root>/`.
    const dir = tidy(new URL('.', moduleUrl).pathname)
    derived = dir.endsWith(`/${ASSETS_DIR}/`) ? dir.slice(0, -(ASSETS_DIR.length + 1)) : dir
  } catch {
    derived = '/'
  }

  return pathname.startsWith(derived) ? tidy(derived) : '/'
}

/** Vite's `build.assetsDir`. Kept in step with vite.config.ts by a test. */
const ASSETS_DIR = 'assets'

let basePathCache: string | null = null

/** The configured Vite base, resolved to an absolute path for this page. */
export function appBasePath(): string {
  if (basePathCache !== null) return basePathCache
  basePathCache = resolveBasePath({
    baseUrl: import.meta.env.BASE_URL || './',
    moduleUrl: import.meta.url,
    locationHref: window.location.href,
  })
  return basePathCache
}

/** Test seam: forget the memoised base. Not used by the app. */
export function resetBasePathCache(): void {
  basePathCache = null
}

/** The route portion of the current browser URL, excluding the deploy prefix. */
export function appPath(): string {
  const base = appBasePath()
  const pathname = window.location.pathname
  if (base === '/') return pathname || '/'
  if (pathname === base.slice(0, -1) || pathname === base) return '/'
  if (pathname.startsWith(base)) return `/${pathname.slice(base.length)}`
  return pathname || '/'
}

/** `/products/:id/edit` → `^/products/([^/]+)/edit$`, `['id']`. */
function compile(path: string): { matcher: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1))
        return '([^/]+)'
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { matcher: new RegExp(`^${pattern}$`), paramNames }
}

/**
 * A route as a URL the browser can be given: the deploy prefix plus the path.
 *
 * Exported because anchors need it too. A sidebar link whose `href` is the
 * bare route looks right (the click handler calls the router) until someone
 * middle-clicks it, at which point the browser is asked for a path with no
 * deploy prefix — on Pages that is a different site's 404, not ours.
 */
export function routeHref(to: string): string {
  return absoluteRoute(to)
}

function absoluteRoute(to: string): string {
  const route = to.startsWith('/') ? to : `/${to}`
  const base = appBasePath()
  return `${base === '/' ? '' : base.slice(0, -1)}${route}` || '/'
}

/**
 * Restore the route captured by the GitHub Pages 404 hand-off.
 *
 * This must also run before authentication bootstrap. An anonymous visitor to
 * `/developer` is shown the shared login screen without starting the router;
 * waiting for `Router.start()` would therefore leave the address bar at the
 * Pages entry point and lose the intended post-login destination.
 */
export function restoreInitialLocation(): void {
  const hash = window.location.hash
  if (hash.startsWith('#/')) {
    const legacy = hash.slice(1)
    window.history.replaceState(null, '', `${absoluteRoute(legacy)}${window.location.search}`)
    return
  }

  // GitHub Pages' 404 page stores the deep link here before returning to the
  // entry point. sessionStorage is used only for this one hand-off and is
  // removed immediately, so a later reload never replays an old route.
  try {
    const saved = sessionStorage.getItem('mekholi.page-redirect')
    if (!saved) return
    sessionStorage.removeItem('mekholi.page-redirect')
    const parsed = JSON.parse(saved) as { path?: string; search?: string }
    if (typeof parsed.path === 'string' && parsed.path.startsWith('/')) {
      window.history.replaceState(null, '', `${absoluteRoute(parsed.path)}${parsed.search ?? ''}`)
    }
  } catch {
    // Storage may be disabled. The root route remains a safe fallback.
  }
}

export class Router {
  readonly #routes: CompiledRoute[] = []
  #container: HTMLElement
  #guard: RouterOptions['guard']
  #onNavigate: RouterOptions['onNavigate']
  #onError: RouterOptions['onError']
  #fallback: string
  #current: { route: Route; ctx: RouteContext } | null = null
  #started = false
  #onPopState = (): void => {
    void this.#resolve()
  }

  constructor(options: RouterOptions) {
    this.#container = options.container
    this.#guard = options.guard
    this.#onNavigate = options.onNavigate
    this.#onError = options.onError
    this.#fallback = options.fallback ?? '/'
  }

  add(route: Route): this {
    const { matcher, paramNames } = compile(route.path)
    this.#routes.push({ route, matcher, paramNames })
    return this
  }

  addAll(routes: readonly Route[]): this {
    for (const route of routes) this.add(route)
    return this
  }

  start(): void {
    if (this.#started) return
    restoreInitialLocation()
    this.#started = true
    window.addEventListener('popstate', this.#onPopState)
    void this.#resolve()
  }

  stop(): void {
    window.removeEventListener('popstate', this.#onPopState)
    this.#started = false
  }

  get current(): Route | null {
    return this.#current?.route ?? null
  }

  get currentContext(): RouteContext | null {
    return this.#current?.ctx ?? null
  }

  navigate(to: string, options: { replace?: boolean } = {}): void {
    const target = absoluteRoute(to)
    const current = `${window.location.pathname}${window.location.search}`
    const next = `${target}${to.includes('?') ? '' : ''}`
    if (current === next) {
      void this.#resolve()
      return
    }
    if (options.replace) window.history.replaceState(null, '', target)
    else window.history.pushState(null, '', target)
    void this.#resolve()
  }

  /** Re-render the current route without changing the URL. */
  refresh(): void {
    void this.#resolve()
  }

  // ── Resolution ────────────────────────────────────────────────────────

  #parse(): { path: string; query: URLSearchParams } {
    return {
      path: appPath().split('?')[0] || '/',
      query: new URLSearchParams(window.location.search),
    }
  }

  #match(path: string): { compiled: CompiledRoute; params: Record<string, string> } | null {
    for (const compiled of this.#routes) {
      const m = compiled.matcher.exec(path)
      if (m) {
        const params: Record<string, string> = {}
        compiled.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] ?? '')
        })
        return { compiled, params }
      }
    }
    return null
  }

  async #resolve(): Promise<void> {
    const { path, query } = this.#parse()
    const matched = this.#match(path)

    if (!matched) {
      if (path !== this.#fallback) this.navigate(this.#fallback, { replace: true })
      return
    }

    const { compiled, params } = matched

    if (this.#current && this.#current.route !== compiled.route) {
      const leave = this.#current.route.beforeLeave
      if (leave) {
        const ok = await leave()
        if (!ok) {
          this.navigate(this.#current.ctx.path, { replace: true })
          return
        }
      }
    }

    if (this.#guard) {
      const redirect = await this.#guard(compiled.route)
      if (redirect !== null && redirect !== path) {
        this.navigate(redirect, { replace: true })
        return
      }
    }

    const ctx: RouteContext = { params, query, path }
    this.#container.replaceChildren()

    try {
      const view = await compiled.route.render(ctx)
      if (this.#parse().path !== path) return
      this.#container.appendChild(view)
      this.#current = { route: compiled.route, ctx }
      document.title = compiled.route.title ? `${compiled.route.title} · Mekholi` : 'Mekholi'
      this.#onNavigate?.(compiled.route, ctx)
    } catch (error) {
      if (this.#onError) this.#onError(error, compiled.route)
      else console.error(`[router] "${compiled.route.path}" failed to render`, error)
      this.#container.appendChild(this.#errorView(compiled.route, error))
    }
  }

  #errorView(route: Route, error: unknown): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'p-6'
    const title = document.createElement('h1')
    title.className = 'text-lg font-semibold mb-2'
    title.textContent = `Could not load ${route.title}`
    const detail = document.createElement('p')
    detail.className = 'text-sm text-content-muted font-mono'
    detail.textContent = error instanceof Error ? error.message : String(error)
    wrap.append(title, detail)
    return wrap
  }
}
