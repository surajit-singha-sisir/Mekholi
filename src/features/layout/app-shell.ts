/**
 * The application shell (docs/06).
 *
 * Sidebar + topbar + a router outlet. The shell owns no business logic; it
 * renders what the navigation model and the router give it. A plugin that
 * registers a nav item gets a sidebar entry and a route target with no change
 * to this file.
 */

import { t } from '../../shared/i18n'
import { onThemeChange, resolvedTheme, toggleTheme } from '../../shared/theme'
import { h, icon, mount } from '../../components/ui/h'
import { iconButton } from '../../components/ui/button'
import { sidebar, markActive } from './sidebar'
import { openQueue } from './sync-indicator'
import { CommandPalette } from './command-palette'
import type { PluginRegistry } from '../../shared/registry/plugin-registry'
import { sessionStore, activeOrganization, can } from '../../app/state/session'
import { salesFloorStore, setActiveBranch } from '../../app/state/sales-floor'
import { offlineStatus } from '../../app/state/offline'
import { getRepositories } from '../../app/data'
import { pluginHeaderHost } from '../../app/plugin-slots'
import { appPath } from '../../app/router/router'
import { selectOrganization } from '../../app/platform/auth'
import type { EventBus } from '../../shared/bus'

export interface AppShellOptions {
  registry: PluginRegistry
  /**
   * The bus the registry was constructed with. Injected rather than imported
   * from the singleton, so the shell cannot silently listen to a different
   * bus than the one plugins publish to.
   */
  bus: EventBus
  onNavigate: (path: string) => void
  onSignOut: () => void
  /** End a short-lived developer support session and return to control plane. */
  onEndSupport?: () => void
  /** The element the router renders into. */
  outlet: HTMLElement
}

export interface AppShell {
  el: HTMLElement
  outlet: HTMLElement
  palette: CommandPalette
  /** Re-render the sidebar — call after permissions or plugins change. */
  refreshNav: () => void
  /**
   * Move the active highlight to the item matching `path` — call on every
   * navigation. Cheaper than `refreshNav`, and the distinction matters: a
   * full rebuild on each click would reset scroll position and collapsed
   * sections just to move one highlight.
   */
  setActivePath: (path: string) => void
  setTitle: (title: string, subtitle?: string) => void
}

export function appShell(options: AppShellOptions): AppShell {
  const { registry, bus, onNavigate, onSignOut, onEndSupport, outlet } = options

  /**
   * The two homes of the same sidebar. The host owns the width — 240px docked
   * beside the content, off-canvas below `lg` — and the aside fills it.
   */
  const sidebarHost = h('div', { class: 'hidden h-full w-60 shrink-0 lg:block' })
  /** Fills the drawer panel, whose width the panel itself decides. */
  const drawerHost = h('div', { class: 'h-full w-full' })

  // ── Mobile drawer ───────────────────────────────────────────────────────
  // A shop counter is often a phone or a tablet in portrait, so the sidebar
  // has to survive a narrow viewport as an off-canvas panel rather than
  // disappear. The previous version of this drawer was an empty overlay:
  // the hamburger darkened the screen and rendered no navigation at all.
  const drawerPanel = h(
    'div',
    // Slightly wider than the docked rail — thumbs and longer labels — and the
    // aside inside fills it edge to edge.
    { class: 'flex h-full w-72 max-w-[85vw] flex-col bg-surface shadow-2xl' },
    drawerHost
  )
  const drawer = h(
    'div',
    {
      id: 'mobile-drawer',
      class: 'fixed inset-0 z-[80] hidden bg-black/40 lg:hidden',
      'aria-hidden': 'true',
    },
    drawerPanel
  )

  const onDrawerKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeDrawer()
  }

  function closeDrawer(): void {
    drawer.classList.add('hidden')
    drawer.setAttribute('aria-hidden', 'true')
    document.removeEventListener('keydown', onDrawerKey)
  }

  function openDrawer(): void {
    // Re-render so permissions or plugins that changed since the last open
    // are reflected the moment the panel slides in.
    renderSidebar()
    drawer.classList.remove('hidden')
    drawer.setAttribute('aria-hidden', 'false')
    document.addEventListener('keydown', onDrawerKey)
  }

  function toggleDrawer(): void {
    if (drawer.classList.contains('hidden')) openDrawer()
    else closeDrawer()
  }

  // Tapping the dimmed backdrop closes; tapping the panel does not.
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) closeDrawer()
  })
  const titleEl = h('h1', { class: 'truncate text-base font-semibold text-content', text: 'Mekholi' })
  const subtitleEl = h('p', { class: 'truncate text-xs text-content-muted' })

  const palette = new CommandPalette({
    registry,
    onNavigate,
    extraCommands: () => [
      {
        id: 'app:signout',
        label: 'Sign out',
        icon: 'logout',
        group: 'Actions',
        keywords: 'sign out logout exit',
        run: onSignOut,
      },
      {
        id: 'app:theme',
        label: 'Toggle light / dark theme',
        icon: 'dark_mode',
        group: 'Actions',
        keywords: 'theme dark light night mode appearance',
        run: () => void toggleTheme(),
      },
      {
        id: 'app:refresh',
        label: 'Reload this page',
        icon: 'refresh',
        group: 'Actions',
        keywords: 'reload refresh retry',
        run: () => window.location.reload(),
      },
    ],
  })

  const org = activeOrganization()
  const shopName = org?.name ?? sessionStore.state.email ?? 'Mekholi'
  const shopInitial = shopName.charAt(0).toUpperCase()

  const hasMultipleOrgs = sessionStore.state.organizations.length > 1

  const renderSidebar = (): void => {
    const common = { registry, shopName, shopInitial }
    // The footer is built per instance: it is a single DOM element, and a
    // node shared between both sidebars would end up mounted in only one.
    const desktopFooter = hasMultipleOrgs ? buildOrgSwitcher() : undefined
    const drawerFooter = hasMultipleOrgs ? buildOrgSwitcher() : undefined

    mount(
      sidebarHost,
      sidebar({
        ...common,
        onNavigate,
        onOpenPalette: () => palette.open(),
        onSignOut,
        ...(desktopFooter ? { footer: desktopFooter } : {}),
      })
    )
    markActive(sidebarHost, currentPath())

    // The drawer gets its own instance whose every escape hatch — navigating,
    // opening the palette, signing out — closes it first. A drawer that stays
    // open over the page it just navigated to is how mobile UIs end up
    // feeling broken.
    mount(
      drawerHost,
      sidebar({
        ...common,
        onNavigate: (path) => {
          closeDrawer()
          onNavigate(path)
        },
        onOpenPalette: () => {
          closeDrawer()
          palette.open()
        },
        onSignOut: () => {
          closeDrawer()
          onSignOut()
        },
        ...(drawerFooter ? { footer: drawerFooter } : {}),
      })
    )
    markActive(drawerHost, currentPath())
  }

  const shell = h(
    'div',
    // `app-shell` (base.css) rather than `h-screen`: on a phone 100vh is the
    // height with the browser toolbar hidden, so the shell overshoots the
    // visible area, the document scrolls, and the topbar leaves the top of the
    // screen. The class is 100dvh with a vh fallback.
    //
    // No `overflow-hidden` here. It looks harmless and it was, but it silently
    // disables the topbar's `sticky`: an ancestor with a non-visible overflow
    // becomes the sticky element's scroll container, so the bar stuck to a box
    // that was itself scrolling away. Nothing needed the clipping — every
    // overlay in the app (drawer, palette, modal, receipt) is `fixed`, and
    // `main` clips its own overflow because it scrolls on one axis.
    { class: 'app-shell flex w-full bg-surface-muted' },

    // Sidebar — off-canvas below lg. The host owns the width; the aside fills
    // it, so the docked rail and the drawer are the same component at two
    // widths rather than two widths fighting inside one component.
    sidebarHost,

    h(
      'div',
      // `min-h-0` is the whole fix for the blank strip under the app. A flex
      // child's `min-height` defaults to `auto`, i.e. its content height, so
      // this column refused to shrink below whatever the current screen
      // wanted. The column then grew past the shell's 100dvh, the body
      // scrolled, and the overshoot showed as empty space below the page —
      // every screen, most visibly the POS, whose right rail is tall.
      { class: 'flex min-h-0 min-w-0 flex-1 flex-col' },

      // Topbar — pinned to the top of the shell. The bar is a sibling of the
      // scrolling outlet, so it does not move when a view scrolls; `sticky`
      // makes that guarantee explicit for any future scroll container, and the
      // layer sits above page content but below the drawer (z-80) and toasts.
      h(
        'header',
        {
          class:
            'sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4',
        },
        iconButton('menu', 'Open navigation', {
          variant: 'ghost',
          // 48px: the one control that has to be hit with a thumb, one-handed,
          // while the other hand is holding a customer's change.
          size: 'lg',
          class: 'lg:hidden',
          onClick: () => toggleDrawer(),
        }),
        h('img', {
          src: './icons/mekholi-192.png',
          alt: 'Mekholi logo',
          class: 'h-8 w-8 shrink-0 rounded-lg shadow-sm lg:hidden',
          width: '32',
          height: '32',
        }),
        h(
          'div',
          { class: 'min-w-0 flex-1' },
          titleEl,
          subtitleEl
        ),
        h(
          'div',
          { class: 'flex items-center gap-2' },
          // Plugin controls that earned a place on the one always-visible
          // strip — a notification bell, a sync light (docs/05 §7).
          pluginHeaderHost(registry),
          branchSwitcher(registry),
          posButton(onNavigate),
          profileMenu({ shopName, shopInitial, onNavigate, onSignOut })
        )
      ),

      org?.is_support_session
        ? h('div', { class: 'flex shrink-0 flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-content' },
            icon('support_agent', 'text-warning'),
            h('div', { class: 'min-w-0 flex-1' },
              h('p', { class: 'font-semibold', text: 'Developer support session' }),
              h('p', { class: 'text-xs text-content-muted', text: `Full shop access is audited${org.support_expires_at ? ` · expires ${new Date(org.support_expires_at).toLocaleTimeString()}` : ''}` })
            ),
            h('button', { type: 'button', class: 'min-h-9 rounded-md border border-warning/40 px-3 text-sm font-medium hover:bg-warning/10', text: 'Return to Developer', onclick: onEndSupport })
          )
        : null,

      // Router outlet
      // Same reason: without `min-h-0` the outlet's own height wins over
      // `flex-1` and `overflow-y-auto` never engages, so a tall view pushes
      // the document instead of scrolling inside the frame.
      h('main', { class: 'min-h-0 flex-1 overflow-y-auto', id: 'app-outlet' }, outlet)
    ),

    drawer
  )

  renderSidebar()

  // Permissions can change when the organization is switched.
  sessionStore.subscribe(() => renderSidebar())

  // A plugin finishing its load may have added nav items.
  bus.on('plugin.loaded', () => renderSidebar())
  // …and switching one off takes them away. Without this the sidebar kept
  // offering a screen the shop had just turned off, until the next reload.
  bus.on('plugin.changed', () => renderSidebar())

  return {
    el: shell,
    outlet,
    palette,
    refreshNav: renderSidebar,
    setActivePath: (path) => {
      // Both rails: the desktop sidebar and the phone drawer each hold their
      // own copy of the nav, and the one not on screen must not keep a stale
      // highlight for its next opening.
      markActive(sidebarHost, path)
      markActive(drawerHost, path)
    },
    setTitle: (title, subtitle) => {
      titleEl.textContent = title
      if (subtitle === undefined || subtitle === '') {
        subtitleEl.textContent = ''
        subtitleEl.classList.add('hidden')
      } else {
        subtitleEl.textContent = subtitle
        subtitleEl.classList.remove('hidden')
      }
    },
  }
}

function currentPath(): string {
  return appPath().split('?')[0] || '/'
}


/**
 * Which branch this device is selling from.
 *
 * Invisible for the shop with one branch — which is most shops — and a
 * select in the topbar for the shop with two, because "which counter am I
 * standing at" is a fact the cashier should be able to see without opening a
 * settings screen. Changing it re-resolves the whole sales floor: warehouse,
 * register and open session all follow the branch (docs/13 P1-4).
 */
function branchSwitcher(registry: PluginRegistry): HTMLElement {
  const host = h('div', { class: 'hidden' })

  const render = (): void => {
    const { branches, floor, status } = salesFloorStore.state
    // The switcher belongs to the branch plugin: a shop that has not
    // bought (or has switched off) multi-branch is a one-branch shop as
    // far as its tills are concerned. A string check, not an import —
    // the shell does not know the plugin, only whether branches are a
    // capability this shop runs (spec §51).
    if (!registry.loadedIds.includes('branch') || branches.length < 2) {
      host.classList.add('hidden')
      host.replaceChildren()
      return
    }
    host.classList.remove('hidden')

    const select = h('select', {
      'aria-label': 'Branch',
      class:
        'h-9 max-w-[10rem] truncate rounded-md border border-border bg-surface px-2 text-sm ' +
        'text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    }) as HTMLSelectElement
    for (const branch of branches) {
      select.append(
        h('option', {
          value: branch.id,
          text: branch.name,
          ...(branch.id === floor?.branchId ? { selected: 'true' } : {}),
        })
      )
    }
    if (status === 'loading') select.disabled = true
    select.addEventListener('change', () => {
      select.disabled = true
      void setActiveBranch(select.value)
    })

    host.replaceChildren(
      h('label', { class: 'flex items-center gap-1.5' },
        icon('storefront', 'hidden text-base text-content-muted sm:block'),
        select
      )
    )
  }

  salesFloorStore.subscribe(render)
  render()
  return host
}

/**
 * The one button the counter reaches for.
 *
 * Selling is what the app is *for*, and until now getting to the till from
 * another screen meant opening the sidebar and finding it in a list. It sits
 * immediately left of the shop's avatar, where a thumb lands.
 */
function posButton(onNavigate: (path: string) => void): HTMLElement {
  const el = h(
    'button',
    {
      type: 'button',
      'data-action': 'open-pos',
      class:
        // h-9: the same 36px as the avatar beside it. Two controls of
        // different heights in a 56px bar read as a mistake, and they are
        // the only two things in that corner.
        'inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-semibold ' +
        'text-primary-contrast transition-colors hover:bg-primary-hover focus:outline-none ' +
        'focus-visible:ring-2 focus-visible:ring-ring',
      title: 'Point of Sale',
      onClick: () => onNavigate('/pos'),
    },
    icon('point_of_sale', 'text-lg'),
    // The word disappears on a phone; the icon and the shape carry it.
    h('span', { class: 'hidden sm:inline', text: 'POS' })
  )
  return el
}

/**
 * The shop's avatar, and everything behind it.
 *
 * What was here before: a sync chip reading "Online", a register icon, a theme
 * icon and a help icon — four controls competing for the corner, three of them
 * doing something a shopkeeper does once a month.
 *
 * What is here now: the shop's logo, round, with a status dot on its corner.
 * One tap opens the things a shopkeeper actually reaches for. The dot is not
 * decoration and it is not `navigator.onLine`, which lies through a captive
 * portal — it is the sync queue: green when everything has reached the server,
 * amber while sales are waiting, red when the server refused one. Those states
 * used to be a chip with words; now they are a colour plus a line in the menu
 * that opens the queue, which is the only part of it a person can act on.
 */
function profileMenu(options: {
  shopName: string
  shopInitial: string
  onNavigate: (path: string) => void
  onSignOut: () => void
}): HTMLElement {
  const { shopName, shopInitial, onNavigate, onSignOut } = options

  const initial = h('span', { class: 'text-sm font-semibold', text: shopInitial })
  const avatar = h(
    'span',
    {
      class:
        'grid h-9 w-9 place-items-center overflow-hidden rounded-full bg-primary ' +
        'text-primary-contrast ring-1 ring-border',
    },
    initial
  )

  // The dot sits on the avatar's top-right, half outside it, with a ring in
  // the bar's own colour so it reads as a badge rather than a smudge.
  const dot = h('span', {
    class: 'absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-success ring-2 ring-surface',
    'aria-hidden': 'true',
  })

  const trigger = h(
    'button',
    {
      type: 'button',
      'data-action': 'open-profile',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      class:
        'relative rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      title: shopName,
      'aria-label': `${shopName} — menu`,
    },
    avatar,
    dot
  )

  const menu = h('div', {
    class:
      'absolute right-0 top-12 z-40 hidden w-60 overflow-hidden rounded-xl border border-border ' +
      'bg-surface p-1 shadow-lg',
    role: 'menu',
  })

  const wrap = h('div', { class: 'relative' }, trigger, menu)

  const row = (
    iconName: string,
    label: string,
    onClick: () => void,
    extra?: { trailing?: HTMLElement; tone?: string }
  ): HTMLElement =>
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class:
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ' +
          `${extra?.tone ?? 'text-content'} hover:bg-surface-muted focus:outline-none focus-visible:bg-surface-muted`,
        onClick: () => {
          close()
          onClick()
        },
      },
      icon(iconName, 'text-lg text-content-muted'),
      h('span', { class: 'flex-1 truncate', text: label }),
      extra?.trailing ?? null
    )

  const themeRow = (): HTMLElement => {
    const dark = resolvedTheme() === 'dark'
    return h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        'data-action': 'toggle-theme',
        class:
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-content ' +
          'hover:bg-surface-muted focus:outline-none focus-visible:bg-surface-muted',
        // The label says what pressing it *does*, not what the theme is —
        // a screen reader hears the action, which is the convention.
        'aria-label': dark ? t('theme.toggleToLight') : t('theme.toggleToDark'),
        onClick: () => {
          toggleTheme()
          draw()
        },
      },
      icon(dark ? 'light_mode' : 'dark_mode', 'text-lg text-content-muted'),
      h('span', { class: 'flex-1', text: dark ? 'Light theme' : 'Dark theme' }),
      h('span', { class: 'text-xs text-content-subtle', text: dark ? 'Dark' : 'Light' })
    )
  }

  /** Only the pages this user may actually open. */
  const links: Array<[string, string, string, string]> = [
    ['group', 'Customers', '/customers', 'customers.view'],
    ['handshake', 'Suppliers', '/suppliers', 'suppliers.view'],
    ['monitoring', 'Analytics', '/analytics', 'analytics.view'],
    ['assessment', 'Reports', '/reports', 'reports.view'],
    ['settings', 'Settings', '/settings', 'settings.view'],
  ]

  function draw(): void {
    const status = offlineStatus.state
    const waiting = status.failed > 0 || status.pending > 0
    mount(
      menu,
      h('div', { class: 'px-2.5 pb-1.5 pt-2' },
        h('p', { class: 'truncate text-sm font-semibold text-content', text: shopName }),
        h('p', {
          class: `text-xs ${status.failed > 0 ? 'text-danger' : status.pending > 0 ? 'text-warning' : 'text-content-subtle'}`,
          text:
            status.failed > 0
              ? `${status.failed} sale${status.failed === 1 ? '' : 's'} refused`
              : status.pending > 0
                ? `${status.pending} sale${status.pending === 1 ? '' : 's'} waiting to sync`
                : 'Everything is synced',
        })
      ),
      // The queue panel — the only actionable part of the old "Online" chip —
      // is offered exactly when there is something in it to act on.
      waiting
        ? row(
            status.failed > 0 ? 'sync_problem' : 'sync',
            status.failed > 0 ? 'Review refused sales' : 'Sales waiting to sync',
            () => void openQueue(),
            { tone: status.failed > 0 ? 'text-danger' : 'text-content' }
          )
        : null,
      h('div', { class: 'my-1 h-px bg-border' }),
      themeRow(),
      ...links
        .filter(([, , , permission]) => can(permission))
        .map(([glyph, label, path]) => row(glyph, label, () => onNavigate(path))),
      h('div', { class: 'my-1 h-px bg-border' }),
      row('logout', 'Sign out', onSignOut, { tone: 'text-danger' })
    )

    // The dot repeats what the first line of the menu says, for anyone who
    // has not opened it.
    dot.className =
      'absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full ring-2 ring-surface ' +
      (status.failed > 0 ? 'bg-danger' : waiting ? 'bg-warning' : 'bg-success')
    trigger.title = status.failed > 0
      ? `${shopName} — ${status.failed} sale(s) refused`
      : status.pending > 0
        ? `${shopName} — ${status.pending} waiting to sync`
        : `${shopName} — synced`
  }

  function open(): void {
    draw()
    menu.classList.remove('hidden')
    trigger.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onEscape, true)
  }

  function close(): void {
    menu.classList.add('hidden')
    trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onEscape, true)
  }

  const onOutside = (event: Event): void => {
    if (!wrap.contains(event.target as Node)) close()
  }
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      close()
      trigger.focus()
    }
  }

  trigger.addEventListener('click', () => {
    if (menu.classList.contains('hidden')) open()
    else close()
  })

  // The shop's own logo, when it has uploaded one. Fetched once, and a failure
  // is not worth a word: the initial is a perfectly good avatar.
  void (async () => {
    try {
      const settings = await getRepositories().organization.getSettings()
      if (!settings.logoUrl) return
      const img = h('img', {
        src: settings.logoUrl,
        alt: '',
        class: 'h-full w-full object-cover',
      })
      img.addEventListener('error', () => mount(avatar, initial), { once: true })
      mount(avatar, img)
    } catch {
      /* the initial stands */
    }
  })()

  draw()
  offlineStatus.subscribe(() => {
    // Only the dot needs repainting while the menu is shut.
    if (menu.classList.contains('hidden')) draw()
  })
  onThemeChange(() => {
    if (!menu.classList.contains('hidden')) draw()
  })

  return wrap
}

function buildOrgSwitcher(): HTMLElement {
  const orgs = sessionStore.state.organizations
  const active = sessionStore.state.activeOrganizationId

  const list = h('select', {
    class:
      'w-full h-9 rounded-md border border-border bg-surface px-2 text-xs text-content ' +
      'focus:outline-none focus:ring-2 focus:ring-ring',
    'aria-label': 'Switch shop',
  })
  for (const org of orgs) {
    list.appendChild(
      h('option', {
        value: org.organization_id,
        text: org.name,
        selected: org.organization_id === active,
      })
    )
  }

  list.addEventListener('change', () => {
    // Same path as every other organization switch: updates the store, swaps
    // permissions, and emits `session.changed`.
    selectOrganization(list.value)
  })

  return h('div', { class: 'px-1 pb-1' }, list)
}


