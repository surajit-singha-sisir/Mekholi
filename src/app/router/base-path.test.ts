/**
 * Where the app thinks it is deployed.
 *
 * Reported as "plugin routes are wrong, multiple /plugins/plugins/…", and
 * before that as "the page just forwards to the dashboard". One cause: the
 * deploy prefix was derived by resolving Vite's relative `base` ('./')
 * against the *current* URL, so it changed every time the user moved off the
 * root path.
 *
 *     standing on /Mekholi/                      → prefix /Mekholi/
 *     standing on /Mekholi/plugins/printer-setup → prefix /Mekholi/plugins/
 *
 * From the second one, every link built by the router gained a segment and
 * every path it read lost one. Both halves are pinned below, because a test
 * that only ever visits the root is exactly the test that shipped this.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveBasePath } from './router'

/** A production build on GitHub Pages: relative base, assets in /assets/. */
const pages = (href: string): string =>
  resolveBasePath({
    baseUrl: './',
    moduleUrl: 'https://surajit-singha-sisir.github.io/Mekholi/assets/index-B0JU8soB.js',
    locationHref: href,
  })

const PAGES_ROOT = 'https://surajit-singha-sisir.github.io/Mekholi/'

describe('the deploy prefix', () => {
  it('is the same from every route, not just the root', () => {
    expect(pages(PAGES_ROOT)).toBe('/Mekholi/')
    expect(pages(`${PAGES_ROOT}pos`)).toBe('/Mekholi/')
    // The two-segment routes that exposed it.
    expect(pages(`${PAGES_ROOT}plugins/printer-setup`)).toBe('/Mekholi/')
    expect(pages(`${PAGES_ROOT}products/7f3a9c21-0000-4000-8000-000000000000`)).toBe('/Mekholi/')
    expect(pages(`${PAGES_ROOT}plugins/barcode-scanner?tab=test`)).toBe('/Mekholi/')
  })

  it('trusts an absolute base, which is what the dev server gives', () => {
    expect(
      resolveBasePath({ baseUrl: '/', moduleUrl: 'http://localhost:5173/src/app/router/router.ts', locationHref: 'http://localhost:5173/plugins/printer-setup' })
    ).toBe('/')
    expect(
      resolveBasePath({ baseUrl: '/Mekholi/', moduleUrl: 'https://x.test/Mekholi/assets/i.js', locationHref: 'https://x.test/Mekholi/pos' })
    ).toBe('/Mekholi/')
    // A base without its trailing slash is still a directory.
    expect(
      resolveBasePath({ baseUrl: '/Mekholi', moduleUrl: 'https://x.test/Mekholi/assets/i.js', locationHref: 'https://x.test/Mekholi/pos' })
    ).toBe('/Mekholi/')
  })

  it('works when the app is served from the domain root', () => {
    expect(
      resolveBasePath({ baseUrl: './', moduleUrl: 'https://mekholi.test/assets/index-abc.js', locationHref: 'https://mekholi.test/plugins/loyalty' })
    ).toBe('/')
  })

  it('works from a deeper sub-path than one folder', () => {
    expect(
      resolveBasePath({ baseUrl: './', moduleUrl: 'https://x.test/apps/shop/assets/i.js', locationHref: 'https://x.test/apps/shop/plugins/variants' })
    ).toBe('/apps/shop/')
  })

  it('falls back to the site root rather than guessing a prefix that cannot be right', () => {
    // Module served from somewhere unrelated to the page: any prefix we
    // invented here would corrupt every link. '/' is at least honest.
    expect(
      resolveBasePath({ baseUrl: './', moduleUrl: 'https://cdn.test/somewhere/else/i.js', locationHref: 'https://x.test/Mekholi/pos' })
    ).toBe('/')
    expect(
      resolveBasePath({ baseUrl: './', moduleUrl: 'not a url', locationHref: 'https://x.test/pos' })
    ).toBe('/')
  })
})

describe('what the prefix is used for', () => {
  // The two operations the router performs with it, reproduced here so the
  // consequence of a wrong prefix is visible rather than implied.
  const absoluteRoute = (base: string, to: string): string =>
    `${base === '/' ? '' : base.slice(0, -1)}${to.startsWith('/') ? to : `/${to}`}` || '/'

  const appPath = (base: string, pathname: string): string => {
    if (base === '/') return pathname || '/'
    if (pathname === base.slice(0, -1) || pathname === base) return '/'
    if (pathname.startsWith(base)) return `/${pathname.slice(base.length)}`
    return pathname || '/'
  }

  it('builds a link with exactly one /plugins/ in it', () => {
    const base = pages(`${PAGES_ROOT}plugins/printer-setup`)

    const href = absoluteRoute(base, '/plugins/barcode-scanner')
    expect(href).toBe('/Mekholi/plugins/barcode-scanner')
    expect(href).not.toContain('plugins/plugins')
  })

  it('reads a plugin path back whole, so the route matches', () => {
    const base = pages(`${PAGES_ROOT}plugins/printer-setup`)

    // Losing the first segment here is what sent people to the dashboard:
    // '/printer-setup' matches no route, and the fallback is '/'.
    expect(appPath(base, '/Mekholi/plugins/printer-setup')).toBe('/plugins/printer-setup')
    expect(appPath(base, '/Mekholi/')).toBe('/')
    expect(appPath(base, '/Mekholi')).toBe('/')
  })

  it('survives a link followed from a page that is already nested', () => {
    // Navigate, then derive again from where we landed. This is the loop
    // that used to add a segment per hop.
    let href = `${PAGES_ROOT}plugins/printer-setup`
    for (let hop = 0; hop < 3; hop += 1) {
      const base = pages(href)
      const next = absoluteRoute(base, '/plugins/barcode-scanner')
      expect(next).toBe('/Mekholi/plugins/barcode-scanner')
      href = `https://surajit-singha-sisir.github.io${next}`
    }
  })
})

describe('the GitHub Pages deep-link hand-off', () => {
  it('restores the captured path before authentication chooses the login screen', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8')
    const restoreCall = main.indexOf('restoreInitialLocation()')
    const authBootstrap = main.indexOf('await bootstrapSession()')

    expect(restoreCall).toBeGreaterThan(-1)
    expect(authBootstrap).toBeGreaterThan(-1)
    expect(restoreCall).toBeLessThan(authBootstrap)
  })
})

describe('the assets directory assumption', () => {
  it('matches what vite.config.ts actually builds', () => {
    // The relative-base branch strips a trailing `assets/`. If the build is
    // ever configured to put chunks somewhere else, that logic goes stale
    // and every deployed link breaks again — so fail here instead.
    const config = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')
    const configured = /assetsDir:\s*['"]([^'"]+)['"]/.exec(config)?.[1]
    expect(configured ?? 'assets').toBe('assets')
  })
})
