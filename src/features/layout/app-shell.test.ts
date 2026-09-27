/**
 * App shell render test.
 *
 * The shell is the main surface once signed in, so a render failure here
 * would mean a blank screen after login. This proves it composes: the sidebar
 * appears, the topbar shows the shop name, the router outlet is present, and
 * the palette opens on Ctrl+K.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { appShell } from './app-shell'
import { PluginRegistry } from '../../shared/registry/plugin-registry'
import { EventBus } from '../../shared/bus'
import { batchExpiryPlugin } from '../../plugins/batch-expiry'
import { batchExpiryManifest } from '../../plugins/batch-expiry/manifest'
import { sessionStore, EMPTY_SESSION } from '../../app/state/session'
import { resetThemeForTests, theme } from '../../shared/theme'

let registry: PluginRegistry
let bus: EventBus

function signIn(): void {
  sessionStore.reset({
    ...EMPTY_SESSION,
    status: 'authenticated',
    userId: 'u-1',
    email: 'owner@shop.test',
    organizations: [
      {
        organization_id: 'org-1',
        name: 'Rahim Store',
        slug: 'rahim-store',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        role_names: ['Owner'],
        role_keys: ['owner'],
        shop_type: 'grocery',
        is_owner: true,
        permissions: ['dashboard.view', 'inventory.view', 'sales.create'],
      },
    ],
    activeOrganizationId: 'org-1',
    permissions: ['dashboard.view', 'inventory.view', 'sales.create'],
  })
}

beforeEach(async () => {
  bus = new EventBus()
  bus.onError = () => undefined
  registry = new PluginRegistry(bus)
  registry.declare({ manifest: batchExpiryManifest, load: async () => batchExpiryPlugin })
  await registry.sync(['batch-expiry'])
  signIn()
})

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  resetThemeForTests()
})

function build(): {
  el: HTMLElement
  outlet: HTMLElement
  shell: ReturnType<typeof appShell>
} {
  const outlet = document.createElement('div')
  const shell = appShell({
    registry,
    bus,
    onNavigate: vi.fn(),
    onSignOut: vi.fn(),
    outlet,
  })
  document.body.appendChild(shell.el)
  return { el: shell.el, outlet, shell }
}

describe('app shell', () => {
  it('renders the shop name in the sidebar header', () => {
    const { el } = build()
    expect(el.textContent).toContain('Rahim Store')
  })

  it('renders navigation items', () => {
    const { el } = build()
    expect(el.querySelector('[data-nav-id="dashboard"]')).not.toBeNull()
    // The plugin's item, again — this time through the full shell.
    expect(el.querySelector('[data-nav-id="batch-expiry"]')).not.toBeNull()
  })

  it('moves the active highlight on navigation — and off the plugin item', () => {
    const { el, shell } = build()

    // Land on the plugin's screen: its item is the one marked current.
    shell.setActivePath('/plugins/batch-expiry')
    const marked = (): string[] =>
      Array.from(el.querySelectorAll('[aria-current="page"]')).map(
        (item) => (item as HTMLElement).dataset['navId'] ?? ''
      )
    expect(marked()).toContain('batch-expiry')
    expect(marked()).not.toContain('dashboard')

    // Navigate away: the highlight must follow, not stay on the plugin.
    shell.setActivePath('/')
    expect(marked()).toContain('dashboard')
    expect(marked()).not.toContain('batch-expiry')
  })

  it('hides navigation the role cannot use', () => {
    const { el } = build()
    expect(el.querySelector('[data-nav-id="settings"]')).toBeNull()
  })

  it('shows the shop initial as the avatar', () => {
    const { el } = build()
    expect(el.textContent).toContain('R')
  })

  it('contains a search trigger for the command palette', () => {
    const { el } = build()
    expect(el.textContent).toContain('Search')
  })

  it('opens the command palette from the search trigger', () => {
    const { el, shell } = build()
    expect(shell.palette.isOpen).toBe(false)

    const trigger = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Search')
    )
    trigger?.click()

    expect(shell.palette.isOpen).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    shell.palette.close()
  })

  it('opens the mobile drawer from the hamburger and renders nav inside it', () => {
    const { el } = build()
    const burger = el.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')
    const drawer = el.querySelector<HTMLElement>('#mobile-drawer')
    expect(burger).not.toBeNull()
    expect(drawer).not.toBeNull()
    expect(drawer!.classList.contains('hidden')).toBe(true)

    burger!.click()

    expect(drawer!.classList.contains('hidden')).toBe(false)
    // The bug this prevents: an earlier drawer was an empty overlay — the
    // hamburger darkened the screen and contained no navigation at all.
    expect(drawer!.querySelector('[data-nav-id="dashboard"]')).not.toBeNull()
  })

  it('closes the drawer when a nav link inside it is used', () => {
    const { el } = build()
    const burger = el.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!
    const drawer = el.querySelector<HTMLElement>('#mobile-drawer')!
    burger.click()

    const link = drawer.querySelector<HTMLElement>('[data-nav-id="dashboard"]')!
    link.click()

    expect(drawer.classList.contains('hidden')).toBe(true)
  })

  it('closes the drawer on backdrop click and on Escape', () => {
    const { el } = build()
    const burger = el.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!
    const drawer = el.querySelector<HTMLElement>('#mobile-drawer')!

    burger.click()
    // A click that lands on the backdrop itself (event.target === drawer).
    drawer.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(drawer.classList.contains('hidden')).toBe(true)

    burger.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(drawer.classList.contains('hidden')).toBe(true)
  })

  it('re-renders the sidebar when the session changes', () => {
    const { el } = build()
    expect(el.querySelector('[data-nav-id="batch-expiry"]')).not.toBeNull()

    // Drop inventory.view: the plugin item is gated on it, so it must go.
    sessionStore.set({ permissions: ['dashboard.view', 'sales.create'] })

    expect(el.querySelector('[data-nav-id="batch-expiry"]')).toBeNull()
    expect(el.querySelector('[data-nav-id="dashboard"]')).not.toBeNull()
  })

  it('re-renders the sidebar when a plugin finishes loading', async () => {
    const { el } = build()
    expect(el.querySelector('[data-nav-id="late"]')).toBeNull()

    registry.declare({
      manifest: {
        id: 'late',
        name: 'Late',
        version: '1.0.0',
        coreApiVersion: '^1.0.0',
        category: 'optional',
        description: 'late',
      },
      load: async () => ({
        id: 'late',
        name: 'Late',
        version: '1.0.0',
        register: (api) => {
          api.registerNav({ id: 'late', label: 'Late', icon: 'help', section: 'main', route: '/late' })
        },
      }),
    })
    // `sync` publishes `plugin.loaded` on the registry's own bus, which is
    // now the same instance the shell was given — no singleton involved.
    await registry.sync(['batch-expiry', 'late'])

    expect(el.querySelector('[data-nav-id="late"]')).not.toBeNull()
  })

  it('sets the page title', () => {
    const { el, shell } = build()
    shell.setTitle('Point of Sale', 'Counter 1')

    expect(el.textContent).toContain('Point of Sale')
    expect(el.textContent).toContain('Counter 1')
  })

  /**
   * Layout facts, not behaviour — but each one is a bug that shipped.
   *
   * `h-screen` is 100vh, which on a phone is the height with the browser
   * toolbar hidden: the shell overshoots the visible area, the document
   * scrolls, and the topbar slides off the top of the screen. The fix is
   * `.app-shell` (100dvh, vh fallback) in base.css.
   */
  it('sizes the shell to the viewport that is visible, not to h-screen', () => {
    const { el } = build()

    expect(el.classList.contains('app-shell')).toBe(true)
    expect(el.classList.contains('h-screen')).toBe(false)
  })

  /**
   * The blank strip under the app.
   *
   * A flex child's `min-height` is `auto`, i.e. its own content height, so the
   * content column refused to shrink below whatever the current screen wanted.
   * The column grew past the shell's 100dvh, the body scrolled, and the
   * overshoot showed as empty space below the page. `min-h-0` on the column
   * and on the outlet is what makes `overflow-y-auto` engage instead.
   */
  it('lets the content column shrink, so a tall screen scrolls inside the frame', () => {
    const { el } = build()
    const main = el.querySelector('main#app-outlet')
    const column = main?.parentElement

    expect(main?.classList.contains('min-h-0')).toBe(true)
    expect(main?.classList.contains('overflow-y-auto')).toBe(true)
    expect(column?.classList.contains('min-h-0')).toBe(true)
    expect(column?.classList.contains('flex-col')).toBe(true)
  })

  it('pins the topbar to the top of the shell', () => {
    const { el } = build()
    const header = el.querySelector('header')

    expect(header).not.toBeNull()
    expect(header!.classList.contains('sticky')).toBe(true)
    expect(header!.classList.contains('top-0')).toBe(true)
  })

  /**
   * The docked rail is 240px and the drawer panel is 288px. When the aside
   * carried its own `w-60`, the drawer's extra 48px was a white strip down the
   * right of the navigation. The host owns the width; the aside fills it.
   */
  it('makes the sidebar fill whichever host it is in', () => {
    const { el } = build()
    const asides = [...el.querySelectorAll<HTMLElement>('aside')]

    expect(asides.length).toBeGreaterThan(0)
    for (const aside of asides) {
      expect(aside.classList.contains('w-full')).toBe(true)
      expect(aside.classList.contains('w-60')).toBe(false)
    }

    // The docked host is the one that decides 240px.
    const docked = asides[0]!.parentElement
    expect(docked!.classList.contains('w-60')).toBe(true)
    expect(docked!.classList.contains('lg:block')).toBe(true)
  })

  it('renders without an organization (onboarding state)', () => {
    sessionStore.reset({ ...EMPTY_SESSION, status: 'authenticated', userId: 'u', email: 'a@b.c' })

    const { el } = build()

    expect(el.textContent).toContain('Mekholi')
    expect(el.querySelector('[data-nav-id]')).toBeNull()
  })
})

/** Opens the shop menu behind the avatar and returns the shell. */
function shellWithMenu(onNavigate: (path: string) => void = () => {}): HTMLElement {
  const shell = appShell({
    registry,
    bus,
    onNavigate,
    onSignOut: () => {},
    outlet: document.createElement('div'),
  })
  document.body.append(shell.el)
  return shell.el
}

const menuRow = (el: HTMLElement, label: string): HTMLButtonElement =>
  [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((row) =>
    (row.textContent ?? '').includes(label)
  )!

describe('the shop menu behind the avatar', () => {
  it('shows the shop as a circle with its initial, and a status dot on the corner', () => {
    const el = shellWithMenu()
    const trigger = el.querySelector('[data-action="open-profile"]') as HTMLElement

    expect(trigger).not.toBeNull()
    expect(trigger.querySelector('span')?.className).toContain('rounded-full')
    expect(trigger.textContent).toBe('R') // Rahim Store

    // Green, and pinned to the top-right corner of the avatar.
    const dot = trigger.querySelectorAll('span')[trigger.querySelectorAll('span').length - 1]!
    expect(dot.className).toContain('bg-success')
    expect(dot.className).toContain('-top-0.5')
    expect(dot.className).toContain('-right-0.5')
  })

  it('keeps the menu shut until the avatar is tapped, and closes on Escape', () => {
    const el = shellWithMenu()
    const trigger = el.querySelector('[data-action="open-profile"]') as HTMLElement
    const menu = el.querySelector('[role="menu"]') as HTMLElement

    expect(menu.classList.contains('hidden')).toBe(true)
    trigger.click()
    expect(menu.classList.contains('hidden')).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(menu.classList.contains('hidden')).toBe(true)
  })

  it('carries the things a shopkeeper reaches for — and only the ones they may open', () => {
    // This owner holds `dashboard.view`, `inventory.view` and `sales.create`.
    const el = shellWithMenu()
    ;(el.querySelector('[data-action="open-profile"]') as HTMLElement).click()

    const labels = [...el.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent ?? '')
    expect(el.querySelector('[data-action="toggle-theme"]')).not.toBeNull()
    expect(labels.some((label) => label.includes('Sign out'))).toBe(true)
    // A page this role cannot open is not offered, rather than offered and
    // then refused by the router.
    expect(labels.some((label) => label.includes('Settings'))).toBe(false)

    sessionStore.reset({
      ...sessionStore.state,
      permissions: ['customers.view', 'suppliers.view', 'analytics.view', 'reports.view', 'settings.view'],
    })
    const allowed = shellWithMenu()
    ;(allowed.querySelector('[data-action="open-profile"]') as HTMLElement).click()
    const full = [...allowed.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent ?? '')
    for (const expected of ['Customers', 'Suppliers', 'Analytics', 'Reports', 'Settings']) {
      expect(full.some((label) => label.includes(expected))).toBe(true)
    }
  })

  it('navigates from a menu row, and shuts behind itself', () => {
    sessionStore.reset({ ...sessionStore.state, permissions: ['customers.view'] })
    const went: string[] = []
    const el = shellWithMenu((path) => went.push(path))
    ;(el.querySelector('[data-action="open-profile"]') as HTMLElement).click()

    menuRow(el, 'Customers').click()

    expect(went).toEqual(['/customers'])
    expect((el.querySelector('[role="menu"]') as HTMLElement).classList.contains('hidden')).toBe(true)
  })

  it('leaves no loose icon buttons in the corner', () => {
    const el = shellWithMenu()
    const header = el.querySelector('header')!
    const labels = [...header.querySelectorAll('button')].map(
      (button) => button.getAttribute('data-action') ?? button.getAttribute('aria-label') ?? ''
    )

    // The menu (for a phone) and the two new controls. No register icon, no
    // theme icon, no help icon, and no "Online" chip.
    expect(labels.filter((label) => label === 'Help')).toEqual([])
    expect(labels.filter((label) => label === 'Open register')).toEqual([])
    expect(header.textContent).not.toContain('Online')
  })
})

describe('the POS button', () => {
  it('sits in the top bar and goes straight to the till', () => {
    const went: string[] = []
    const el = shellWithMenu((path) => went.push(path))
    const pos = el.querySelector('[data-action="open-pos"]') as HTMLButtonElement

    expect(pos).not.toBeNull()
    expect(pos.textContent).toContain('POS')
    pos.click()
    expect(went).toEqual(['/pos'])
  })

  it('is immediately left of the shop avatar', () => {
    const el = shellWithMenu()
    const pos = el.querySelector('[data-action="open-pos"]')!
    const avatar = el.querySelector('[data-action="open-profile"]')!
    // Same row, POS first.
    expect(pos.parentElement).toBe(avatar.parentElement!.parentElement)
    expect(pos.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the theme switch', () => {
  it('lives in the shop menu, and says what pressing it does', () => {
    const el = shellWithMenu()
    ;(el.querySelector('[data-action="open-profile"]') as HTMLElement).click()

    const before = el.querySelector('[data-action="toggle-theme"]') as HTMLElement
    expect(before.getAttribute('aria-label')).toBe('Switch to dark theme')
    before.click()

    expect(theme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    // The row is redrawn, so it is read again rather than held on to.
    const after = el.querySelector('[data-action="toggle-theme"]') as HTMLElement
    expect(after.getAttribute('aria-label')).toBe('Switch to light theme')
    after.click()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('what became of the sync chip', () => {
  it('offers the queue only when there is something in it', async () => {
    const { offlineStatus } = await import('../../app/state/offline')
    const el = shellWithMenu()
    ;(el.querySelector('[data-action="open-profile"]') as HTMLElement).click()
    expect(el.textContent).toContain('Everything is synced')
    expect(menuRow(el, 'waiting to sync')).toBeUndefined()

    offlineStatus.set({ ...offlineStatus.state, pending: 3 })
    ;(el.querySelector('[data-action="open-profile"]') as HTMLElement).click()
    ;(el.querySelector('[data-action="open-profile"]') as HTMLElement).click()

    expect(el.textContent).toContain('3 sales waiting to sync')
    expect(menuRow(el, 'waiting to sync')).not.toBeUndefined()

    // The dot carries the same news for anyone who has not opened the menu.
    const trigger = el.querySelector('[data-action="open-profile"]') as HTMLElement
    const dot = [...trigger.querySelectorAll('span')].at(-1)!
    expect(dot.className).toContain('bg-warning')

    offlineStatus.set({ ...offlineStatus.state, pending: 0, failed: 0 })
  })
})
