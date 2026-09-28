/**
 * The sidebar (spec §40, docs/06).
 *
 * Rendered from `buildNavigation()`, which means a plugin's nav item appears
 * here without this file knowing it exists. Sections with many entries start
 * collapsed so a cashier sees five buttons, not thirty.
 */

import { h, icon } from '../../components/ui/h'
import { routeHref } from '../../app/router/router'
import { buildNavigation, navLabel, navPluginMark, sectionLabel, type NavPluginMark } from './navigation'
import type { NavItem } from '../../shared/registry/plugin-types'
import { t } from '../../shared/i18n'
import type { PluginRegistry } from '../../shared/registry/plugin-registry'

export interface SidebarOptions {
  registry: PluginRegistry
  shopName: string
  shopInitial: string
  /** Called with the target path; the shell owns the router. */
  onNavigate: (path: string) => void
  onOpenPalette: () => void
  onSignOut: () => void
  /** Extra entries pinned to the footer, e.g. an org switcher. */
  footer?: HTMLElement
}

const COLLAPSED_KEY = 'mekholi.sidebar.collapsed'

export function sidebar(options: SidebarOptions): HTMLElement {
  const { registry, shopName, onNavigate, onOpenPalette, onSignOut, footer } = options

  const collapsedSections = new Set<string>(readCollapsed())

  const nav = h('nav', {
    // The nav is the sidebar's scroll container, so it is the thing that owns
    // a scrollbar. `scrollbar-slim` keeps the affordance while stopping the
    // platform's default width from eating the right-hand edge of the rail.
    class: 'flex-1 overflow-y-auto px-2 py-3 space-y-4 scrollbar-slim',
    'aria-label': t('shell.mainNavigation'),
  })

  const groups = buildNavigation(registry)

  for (const group of groups) {
    const isCollapsible = groups.length > 1 && group.section.collapsedByDefault === true
    const collapsed = collapsedSections.has(group.section.id)

    const listId = `nav-section-${group.section.id}`
    const list = h('ul', { id: listId, class: 'space-y-0.5', role: 'list' })

    for (const item of group.items) {
      list.appendChild(navItem(item, onNavigate, navPluginMark(registry, item)))
    }

    const header = h(
      'button',
      {
        type: 'button',
        class:
          'flex w-full items-center justify-between rounded px-2 py-1 text-[11px] font-semibold ' +
          'uppercase tracking-wider text-content-subtle hover:text-content-muted ' +
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'aria-expanded': String(!collapsed),
        'aria-controls': listId,
      },
      h('span', { text: sectionLabel(group.section) }),
      icon(collapsed ? 'chevron_right' : 'expand_more', 'text-sm transition-transform')
    )

    if (isCollapsible) {
      header.addEventListener('click', () => {
        const nowCollapsed = !collapsedSections.has(group.section.id)
        if (nowCollapsed) {
          collapsedSections.add(group.section.id)
        } else {
          collapsedSections.delete(group.section.id)
        }
        writeCollapsed(collapsedSections)
        list.classList.toggle('hidden', nowCollapsed)
        header.setAttribute('aria-expanded', String(!nowCollapsed))
        header.lastElementChild?.replaceChildren(
          icon(nowCollapsed ? 'chevron_right' : 'expand_more', 'text-sm')
        )
      })
    } else {
      // Not collapsible: render as a static label, not a button.
      header.disabled = true
      header.classList.add('cursor-default')
    }

    if (collapsed) list.classList.add('hidden')

    nav.append(h('div', null, header, list))
  }

  if (groups.length === 0) {
    nav.appendChild(
      h(
        'p',
        { class: 'px-2 py-4 text-xs text-content-subtle', text: t('shell.noFeatures') }
      )
    )
  }

  return h(
    'aside',
    {
      // `w-full`, not `w-60`: the width belongs to the host, which is two
      // different things — 240px docked beside the content, up to 288px inside
      // the mobile drawer. When the aside carried its own `w-60`, the drawer's
      // extra 48px showed as a strip of the panel's white background down the
      // right-hand side of the navigation.
      class:
        'flex h-full w-full shrink-0 flex-col border-r border-border bg-surface-muted',
      'aria-label': t('shell.sidebar'),
    },
    // Shop identity
    h(
      'div',
      { class: 'flex items-center gap-2.5 border-b border-border px-3 py-3' },
      h('img', {
        src: './icons/mekholi-192.png',
        alt: 'Mekholi logo',
        class: 'h-8 w-8 shrink-0 rounded-lg shadow-sm',
        width: '32',
        height: '32',
      }),
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('p', { class: 'truncate text-sm font-semibold text-content', text: shopName }),
        h('p', { class: 'truncate text-[11px] text-content-subtle', text: 'Mekholi' })
      )
    ),

    // Search / palette trigger
    h(
      'div',
      { class: 'px-3 pt-3' },
      h(
        'button',
        {
          type: 'button',
          class:
            'flex h-9 w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 ' +
            'text-sm text-content-subtle hover:border-ring hover:text-content-muted ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          onclick: onOpenPalette,
        },
        icon('search', 'text-base'),
        h('span', { class: 'flex-1 text-left', text: t('shell.search') }),
        h('kbd', {
          // Hidden on touch-sized screens: a keyboard shortcut hint is noise
          // on a phone, and it steals width from the search label.
          class:
            'hidden rounded border border-border bg-surface-muted px-1.5 py-0.5 ' +
            'font-mono text-[10px] text-content-subtle sm:inline-block',
          text: 'Ctrl K',
        })
      )
    ),

    nav,

    h(
      'div',
      { class: 'border-t border-border p-2 space-y-1' },
      footer ?? null,
      h(
        'button',
        {
          type: 'button',
          class:
            'flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-content-muted ' +
            'hover:bg-surface hover:text-content focus-visible:outline-none focus-visible:ring-2 ' +
            'focus-visible:ring-ring',
          onclick: onSignOut,
        },
        icon('logout', 'text-lg'),
        h('span', { text: t('shell.signOut') })
      )
    )
  )
}

/** Tailwind classes per mark tone, kept whole so the scanner can see them. */
const MARK_TONE: Record<NavPluginMark['tone'], string> = {
  free: 'text-success',
  paid: 'text-warning',
  trial: 'text-warning',
}

function navItem(
  item: NavItem,
  onNavigate: (path: string) => void,
  mark: NavPluginMark | null = null
): HTMLLIElement {
  const link = h(
    'a',
    {
      href: routeHref(item.route),
      class:
        'group flex min-h-[44px] items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ' +
        'text-content-muted hover:bg-secondary hover:text-content ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      // The href carries the deploy prefix so the browser can follow it;
      // the route is kept separately because that is what the router and
      // `markActive` talk in. Comparing a prefixed href against an app path
      // would leave nothing highlighted on a sub-path deployment.
      dataset: { navId: item.id, navRoute: item.route },
    },
    icon(item.icon, 'text-lg shrink-0'),
    h('span', { class: 'flex-1 truncate', text: navLabel(item) })
  )

  link.addEventListener('click', (event) => {
    event.preventDefault()
    onNavigate(item.route)
  })

  if (mark) {
    // `ml-auto` on the first thing after the label, so the mark sits hard
    // right whether or not a count follows it.
    link.appendChild(
      h('span', {
        class: `material-symbols-rounded ml-auto shrink-0 select-none text-base leading-none ${MARK_TONE[mark.tone]}`,
        // Material Symbols renders the ligature; the title carries the
        // meaning for everyone who is not looking at a coin-shaped glyph.
        text: mark.icon,
        title: mark.title,
        'aria-label': mark.title,
        role: 'img',
        dataset: { pluginMark: mark.tone },
      })
    )
  }

  const badgeValue = item.badge?.()
  if (badgeValue !== null && badgeValue !== undefined && badgeValue !== '' && badgeValue !== 0) {
    link.appendChild(
      h('span', {
        class:
          'ml-auto rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-semibold ' +
          'text-danger-foreground tabular-nums',
        text: String(badgeValue),
      })
    )
  }

  return h('li', null, link)
}

/** Mark the item matching the current path. Called by the shell on navigate. */
export function markActive(sidebarEl: HTMLElement, path: string): void {
  for (const el of sidebarEl.querySelectorAll<HTMLElement>('[data-nav-id]')) {
    el.classList.remove('bg-primary-soft', 'text-primary', 'font-semibold', 'shadow-sm')
    el.removeAttribute('aria-current')
  }

  // Longest prefix wins so `/products/123` highlights `products`.
  let best: HTMLElement | null = null
  let bestLength = -1
  for (const el of sidebarEl.querySelectorAll<HTMLElement>('[data-nav-id]')) {
    const href = el.getAttribute('href') ?? ''
    const raw = el.dataset.navRoute ?? href
    const route = raw.startsWith('#') ? raw.slice(1) : raw
    if (route === path || (route !== '/' && path.startsWith(`${route}/`))) {
      if (route.length > bestLength) {
        best = el
        bestLength = route.length
      }
    } else if (route === '/' && path === '/') {
      best = el
      bestLength = 1
    }
  }

  if (best) {
    // The current page was marked with a white pill on a grey rail — almost
    // invisible, and identical to hover. A brand tint with a bolder label is
    // the only state on this screen that has to be readable at a glance.
    best.classList.add('bg-primary-soft', 'text-primary', 'font-semibold', 'shadow-sm')
    best.setAttribute('aria-current', 'page')
  }
}

function readCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function writeCollapsed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]))
  } catch {
    /* persistence is a nicety, not a requirement */
  }
}
