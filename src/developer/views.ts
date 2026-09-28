import { h, mount } from '../components/ui/h'
import { button, spinner } from '../components/ui/button'
import { card, badge, emptyState } from '../components/ui/card'
import { input } from '../components/ui/input'
import { controlPlane, type DeveloperShop } from './control-plane'

function page(title: string, description: string): { root: HTMLElement; body: HTMLElement } {
  const body = h('div', { class: 'space-y-4' }, h('div', { class: 'flex justify-center p-12' }, spinner()))
  return {
    root: h('div', { class: 'w-full p-3 sm:p-6' },
      h('div', { class: 'mb-5' }, h('h1', { class: 'text-xl font-semibold text-content', text: title }), h('p', { class: 'mt-1 text-sm text-content-muted', text: description })), body),
    body,
  }
}

function failure(body: HTMLElement, error: unknown): void {
  mount(body, emptyState('Control-plane data could not be loaded', { description: error instanceof Error ? error.message : String(error), iconName: 'error' }))
}

export function developerOverviewView(onNavigate: (path: string) => void): HTMLElement {
  const { root, body } = page('Platform overview', 'Operational health across Mekholi shops and plugins.')
  void controlPlane.summary().then((s) => {
    const stat = (label: string, value: number, icon: string, bad = false) => card(
      h('div', { class: 'flex items-center justify-between gap-2' }, h('p', { class: 'text-xs font-medium text-content-muted', text: label }), h('span', { class: `material-symbols-rounded ${bad ? 'text-danger' : 'text-content-subtle'}`, text: icon })),
      h('p', { class: `mt-2 text-3xl font-semibold tabular-nums ${bad ? 'text-danger' : 'text-content'}`, text: String(value) })
    )
    mount(body,
      h('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' },
        stat('Shops', s.shops, 'storefront'), stat('Created today', s.shops_today, 'add_business'), stat('Auth users', s.users, 'group'), stat('Plugin packages', s.packages, 'extension'),
        stat('Enabled installations', s.enabled_plugins, 'check_circle'), stat('Plugin errors', s.plugin_errors, 'error', s.plugin_errors > 0), stat('Errors in 24 hours', s.error_logs_24h, 'warning', s.error_logs_24h > 0)),
      h('div', { class: 'flex flex-wrap gap-2' },
        button('Browse shops', { variant: 'primary', icon: 'store', onClick: () => onNavigate('/developer/shops') }),
        button('Plugin catalogue', { variant: 'secondary', icon: 'extension', onClick: () => onNavigate('/developer/plugins') }),
        button('Platform logs', { variant: 'secondary', icon: 'terminal', onClick: () => onNavigate('/developer/logs') }))
    )
  }).catch((e) => failure(body, e))
  return root
}

function shopRow(shop: DeveloperShop, onNavigate: (path: string) => void): HTMLElement {
  return h('button', { type: 'button', class: 'grid w-full grid-cols-2 gap-3 border-b border-border p-4 text-left last:border-0 hover:bg-surface-muted sm:grid-cols-6', onclick: () => onNavigate(`/developer/shops/${shop.id}`) },
    h('div', { class: 'col-span-2' }, h('p', { class: 'font-medium text-content', text: shop.name }), h('p', { class: 'text-xs font-mono text-content-subtle', text: shop.id })),
    h('p', { class: 'text-sm text-content-muted', text: shop.shop_type ?? 'Unspecified' }),
    h('p', { class: 'text-sm tabular-nums text-content', text: `${shop.staff_count} staff` }),
    h('p', { class: 'text-sm tabular-nums text-content', text: `${shop.plugin_count} plugins` }),
    shop.has_plugin_error ? badge('Plugin error', { tone: 'danger' }) : badge('Healthy', { tone: 'success' }))
}

export function developerShopsView(onNavigate: (path: string) => void): HTMLElement {
  const { root, body } = page('Shops', 'Tenant directory, configuration and plugin health.')
  const search = input({ type: 'search', placeholder: 'Search name, slug or organization ID…' })
  let timer = 0
  const load = async () => {
    mount(body, h('div', { class: 'flex justify-center p-12' }, spinner()))
    try {
      const shops = await controlPlane.shops(search.value)
      mount(body, search, shops.length ? h('div', { class: 'overflow-hidden rounded-xl border border-border bg-surface' }, ...shops.map((s) => shopRow(s, onNavigate))) : emptyState('No shops match', { iconName: 'store_off' }))
    } catch (e) { failure(body, e) }
  }
  search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 250) })
  void load()
  return root
}

export function developerShopView(id: string): HTMLElement {
  const { root, body } = page('Shop', 'Profile, infrastructure and installed plugins.')
  void controlPlane.shop(id).then((shop) => {
    mount(body,
      h('div', { class: 'grid gap-3 md:grid-cols-2 xl:grid-cols-4' },
        card(h('p', { class: 'text-xs text-content-muted', text: 'Organization' }), h('p', { class: 'mt-1 text-lg font-semibold', text: shop.name }), h('p', { class: 'mt-1 text-xs font-mono text-content-subtle', text: shop.id })),
        card(h('p', { class: 'text-xs text-content-muted', text: 'Profile' }), h('p', { class: 'mt-1 font-medium', text: shop.shop_type ?? 'Unspecified' }), h('p', { class: 'text-xs text-content-subtle', text: `${shop.currency} · ${shop.timezone}` })),
        card(h('p', { class: 'text-xs text-content-muted', text: 'People & branches' }), h('p', { class: 'mt-1 text-2xl font-semibold', text: `${shop.staff_count} / ${shop.branch_count}` }), h('p', { class: 'text-xs text-content-subtle', text: 'staff / branches' })),
        card(h('p', { class: 'text-xs text-content-muted', text: 'Infrastructure' }), h('p', { class: 'mt-1 text-2xl font-semibold', text: `${shop.warehouse_count ?? 0} / ${shop.register_count ?? 0}` }), h('p', { class: 'text-xs text-content-subtle', text: 'warehouses / registers' }))
      ),
      h('section', { class: 'overflow-hidden rounded-xl border border-border bg-surface' },
        h('div', { class: 'border-b border-border p-4' }, h('h2', { class: 'font-semibold text-content', text: 'Installed plugins' })),
        ...(shop.plugins?.length ? shop.plugins.map((p) => h('div', { class: 'flex flex-wrap items-center gap-3 border-b border-border p-4 last:border-0' }, h('div', { class: 'min-w-0 flex-1' }, h('p', { class: 'font-medium', text: p.key }), h('p', { class: 'text-xs text-content-subtle', text: `v${p.version}` })), badge(p.enabled ? 'Enabled' : 'Disabled', { tone: p.enabled ? 'success' : 'neutral' }), p.status === 'error' ? badge('Error', { tone: 'danger' }) : null)) : [h('p', { class: 'p-4 text-sm text-content-muted', text: 'No plugins installed.' })])
      )
    )
  }).catch((e) => failure(body, e))
  return root
}

export function developerPluginsView(): HTMLElement {
  const { root, body } = page('Plugin catalogue', 'Server packages, versions, permissions and installation health.')
  void controlPlane.plugins().then((plugins) => mount(body, h('div', { class: 'grid gap-3 lg:grid-cols-2' }, ...plugins.map((p) => card(
    h('div', { class: 'flex items-start justify-between gap-3' }, h('div', null, h('h2', { class: 'font-semibold text-content', text: p.name }), h('p', { class: 'text-xs font-mono text-content-subtle', text: `${p.key} · v${p.version}` })), badge(p.category, { tone: 'neutral' })),
    h('p', { class: 'mt-2 text-sm text-content-muted', text: p.description ?? 'No description' }),
    h('div', { class: 'mt-3 grid grid-cols-4 gap-2 text-center text-xs' }, ...[[p.installed_shops,'Installed'],[p.enabled_shops,'Enabled'],[p.permission_count,'Permissions'],[p.migration_count,'Migrations']].map(([v,l]) => h('div', { class: 'rounded-md bg-surface-muted p-2' }, h('p', { class: 'text-lg font-semibold tabular-nums', text: String(v) }), h('p', { class: 'text-content-subtle', text: String(l) })))),
    p.error_shops > 0 ? h('p', { class: 'mt-2 text-xs text-danger', text: `${p.error_shops} shop(s) need attention` }) : null
  ))))).catch((e) => failure(body, e))
  return root
}

export function developerLogsView(): HTMLElement {
  const { root, body } = page('Platform logs', 'Structured control-plane and worker events. Sensitive payloads are not exposed.')
  void controlPlane.logs().then((logs) => mount(body, logs.length ? h('div', { class: 'overflow-hidden rounded-xl border border-border bg-surface' }, ...logs.map((l) => h('div', { class: 'grid gap-2 border-b border-border p-4 last:border-0 sm:grid-cols-[10rem_7rem_1fr]' }, h('p', { class: 'text-xs text-content-subtle', text: new Date(l.occurred_at).toLocaleString() }), badge(l.severity, { tone: l.severity === 'error' || l.severity === 'critical' ? 'danger' : l.severity === 'warning' ? 'warning' : 'neutral' }), h('div', null, h('p', { class: 'text-sm font-medium', text: l.action }), h('p', { class: 'text-sm text-content-muted', text: l.message }), h('p', { class: 'text-xs text-content-subtle', text: [l.organization_name,l.plugin_key,l.correlation_id].filter(Boolean).join(' · ') }))))) : emptyState('No platform logs yet', { description: 'The telemetry store is ready; events appear when server-side ingestion is connected.', iconName: 'terminal' }))).catch((e) => failure(body, e))
  return root
}
