import { h, icon } from '../components/ui/h'
import { iconButton } from '../components/ui/button'
import { sessionStore } from '../app/state/session'

export interface DeveloperShell {
  el: HTMLElement
  setTitle: (title: string) => void
  setActivePath: (path: string) => void
}

const NAV = [
  { path: '/developer', label: 'Overview', icon: 'space_dashboard' },
  { path: '/developer/shops', label: 'Shops', icon: 'storefront' },
  { path: '/developer/plugins', label: 'Plugins', icon: 'extension' },
  { path: '/developer/logs', label: 'Platform logs', icon: 'terminal' },
]

export function developerShell(options: { outlet: HTMLElement; onNavigate: (path: string) => void; onSignOut: () => void }): DeveloperShell {
  const title = h('h1', { class: 'truncate font-semibold text-content', text: 'Developer' })
  const links: HTMLButtonElement[] = []
  const nav = h('nav', { class: 'space-y-1 p-3' }, ...NAV.map((item) => {
    const link = h('button', { type: 'button', class: 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-content-muted hover:bg-surface-muted hover:text-content', onclick: () => options.onNavigate(item.path) }, icon(item.icon, 'text-lg'), h('span', { text: item.label })) as HTMLButtonElement
    link.dataset.path = item.path
    links.push(link)
    return link
  }))
  const aside = h('aside', { class: 'hidden h-full w-60 shrink-0 border-r border-border bg-surface lg:flex lg:flex-col' },
    h('div', { class: 'border-b border-border p-4' }, h('p', { class: 'text-lg font-bold text-primary', text: 'Mekholi Developer' }), h('p', { class: 'mt-1 text-xs text-content-subtle', text: 'Production control plane' })), nav,
    h('div', { class: 'mt-auto border-t border-border p-3' }, h('p', { class: 'truncate text-xs text-content-muted', text: sessionStore.state.email ?? '' }), h('button', { type: 'button', class: 'mt-2 min-h-10 w-full rounded-md text-left text-sm text-danger hover:bg-danger/5 px-2', text: 'Sign out', onclick: options.onSignOut }))
  )
  const mobile = h('select', { class: 'rounded-md border border-border bg-surface px-2 py-2 text-sm lg:hidden', onchange: (e: Event) => options.onNavigate((e.target as HTMLSelectElement).value) }, ...NAV.map((n) => h('option', { value: n.path, text: n.label })))
  const el = h('div', { class: 'app-shell flex w-full bg-surface-muted' }, aside,
    h('div', { class: 'flex min-h-0 min-w-0 flex-1 flex-col' },
      h('header', { class: 'z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-5' }, mobile, title, h('span', { class: 'ml-auto rounded-full bg-warning/10 px-2 py-1 text-xs font-medium text-warning', text: 'PRODUCTION' }), iconButton('logout', 'Sign out', { onClick: options.onSignOut })),
      h('main', { class: 'min-h-0 flex-1 overflow-y-auto' }, options.outlet)))
  return {
    el,
    setTitle: (value) => { title.textContent = value },
    setActivePath: (path) => { for (const link of links) { const active = link.dataset.path === path || (link.dataset.path !== '/developer' && path.startsWith(`${link.dataset.path}/`)); link.classList.toggle('bg-primary/10', active); link.classList.toggle('text-primary', active) } },
  }
}
