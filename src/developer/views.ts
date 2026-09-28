import { h, mount } from '../components/ui/h'
import { button, spinner } from '../components/ui/button'
import { card, badge, emptyState } from '../components/ui/card'
import { input, select, textarea } from '../components/ui/input'
import { toastError, toastSuccess } from '../components/feedback/toast'
import { routeHref } from '../app/router/router'
import { rememberActiveOrganization } from '../app/platform/auth'
import {
  controlPlane,
  type DeveloperBranch,
  type DeveloperPlugin,
  type DeveloperShop,
  type DeveloperStaff,
  type DeveloperUser,
} from './control-plane'

function page(title: string, description: string): { root: HTMLElement; body: HTMLElement; actions: HTMLElement } {
  const body = h('div', { class: 'space-y-4' }, h('div', { class: 'flex justify-center p-12' }, spinner()))
  const actions = h('div', { class: 'flex flex-wrap gap-2' })
  return {
    root: h('div', { class: 'w-full p-3 sm:p-6' },
      h('div', { class: 'mb-5 flex flex-wrap items-start justify-between gap-3' },
        h('div', null, h('h1', { class: 'text-xl font-semibold text-content', text: title }), h('p', { class: 'mt-1 text-sm text-content-muted', text: description })), actions), body),
    body,
    actions,
  }
}

function failure(body: HTMLElement, error: unknown): void {
  mount(body, emptyState('Control-plane data could not be loaded', { description: error instanceof Error ? error.message : String(error), iconName: 'error' }))
}

interface FormField {
  key: string
  label: string
  value?: string | undefined
  type?: 'text' | 'email' | 'password' | 'select' | 'textarea' | undefined
  options?: Array<{ value: string; label: string }> | undefined
  required?: boolean | undefined
  placeholder?: string | undefined
}

function openForm(options: {
  title: string
  description?: string
  fields: FormField[]
  submitLabel?: string
  danger?: boolean
  onSubmit: (values: Record<string, string>) => Promise<void>
}): void {
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>()
  const overlay = h('div', { class: 'fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-3 sm:items-center' })
  const close = () => overlay.remove()
  const form = h('form', { class: 'max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl' })
  form.append(h('div', { class: 'mb-4' }, h('h2', { class: 'text-lg font-semibold', text: options.title }), options.description ? h('p', { class: 'mt-1 text-sm text-content-muted', text: options.description }) : null))
  for (const item of options.fields) {
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    if (item.type === 'select') control = select({ value: item.value ?? '', options: item.options ?? [] })
    else if (item.type === 'textarea') control = textarea({ value: item.value ?? '', placeholder: item.placeholder })
    else control = input({ type: item.type ?? 'text', value: item.value ?? '', placeholder: item.placeholder, autocomplete: item.type === 'password' ? 'new-password' : undefined })
    if (item.required) control.required = true
    controls.set(item.key, control)
    form.append(h('label', { class: 'mb-3 block' }, h('span', { class: 'mb-1 block text-sm font-medium', text: item.label }), control))
  }
  const cancel = button('Cancel', { variant: 'secondary', onClick: close })
  cancel.type = 'button'
  const submit = button(options.submitLabel ?? 'Save', { variant: options.danger ? 'danger' : 'primary' })
  submit.type = 'submit'
  form.append(h('div', { class: 'mt-5 flex justify-end gap-2' }, cancel, submit))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const values = Object.fromEntries([...controls].map(([key, control]) => [key, control.value]))
    submit.disabled = true
    void options.onSubmit(values).then(() => close()).catch((error: unknown) => {
      submit.disabled = false
      toastError(error instanceof Error ? error.message : String(error))
    })
  })
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close() })
  overlay.append(form)
  document.body.append(overlay)
  ;(controls.values().next().value as HTMLElement | undefined)?.focus()
}

function csv(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : ''
}

function csvArray(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function developerOverviewView(onNavigate: (path: string) => void): HTMLElement {
  const { root, body } = page('Platform overview', 'Operational health across Mekholi shops and plugins.')
  void controlPlane.summary().then((s) => {
    const stat = (label: string, value: number, icon: string, bad = false) => card(
      h('div', { class: 'flex items-center justify-between gap-2' }, h('p', { class: 'text-xs font-medium text-content-muted', text: label }), h('span', { class: `material-symbols-rounded ${bad ? 'text-danger' : 'text-content-subtle'}`, text: icon })),
      h('p', { class: `mt-2 text-3xl font-semibold tabular-nums ${bad ? 'text-danger' : 'text-content'}`, text: String(value) }))
    mount(body,
      h('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' },
        stat('Shops', s.shops, 'storefront'), stat('Created today', s.shops_today, 'add_business'), stat('Auth users', s.users, 'group'), stat('Plugin packages', s.packages, 'extension'),
        stat('Enabled installations', s.enabled_plugins, 'check_circle'), stat('Plugin errors', s.plugin_errors, 'error', s.plugin_errors > 0), stat('Errors in 24 hours', s.error_logs_24h, 'warning', s.error_logs_24h > 0)),
      h('div', { class: 'flex flex-wrap gap-2' },
        button('Browse shops', { variant: 'primary', icon: 'store', onClick: () => onNavigate('/developer/shops') }),
        button('Manage users', { variant: 'secondary', icon: 'group', onClick: () => onNavigate('/developer/users') }),
        button('Plugin catalogue', { variant: 'secondary', icon: 'extension', onClick: () => onNavigate('/developer/plugins') }),
        button('Platform logs', { variant: 'secondary', icon: 'terminal', onClick: () => onNavigate('/developer/logs') })))
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
  const { root, body, actions } = page('Shops', 'Create and manage tenant configuration, people, branches and plugins.')
  actions.append(button('Add shop', { variant: 'primary', icon: 'add_business', onClick: () => openForm({
    title: 'Create shop', description: 'The owner must already have a Mekholi account.', submitLabel: 'Create shop',
    fields: [
      { key: 'name', label: 'Shop name', required: true }, { key: 'slug', label: 'Slug', required: true },
      { key: 'owner_email', label: 'Owner email', type: 'email', required: true }, { key: 'shop_type', label: 'Shop type' },
      { key: 'currency', label: 'Currency', value: 'BDT', required: true }, { key: 'timezone', label: 'Timezone', value: 'Asia/Dhaka', required: true },
      { key: 'branch_name', label: 'First branch', value: 'Main Store', required: true },
    ],
    onSubmit: async (values) => { const result = await controlPlane.command<{ id: string }>('shop.create', values); toastSuccess('Shop created'); onNavigate(`/developer/shops/${result.id}`) },
  }) }))
  const search = input({ type: 'search', placeholder: 'Search name, slug or organization ID…' })
  let timer = 0
  const load = async () => {
    mount(body, h('div', { class: 'flex justify-center p-12' }, spinner()))
    try { const shops = await controlPlane.shops(search.value); mount(body, search, shops.length ? h('div', { class: 'overflow-hidden rounded-xl border border-border bg-surface' }, ...shops.map((s) => shopRow(s, onNavigate))) : emptyState('No shops match', { iconName: 'store_off' })) } catch (e) { failure(body, e) }
  }
  search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 250) })
  void load()
  return root
}

function editBranch(shop: DeveloperShop, branch: DeveloperBranch | null, reload: () => void): void {
  openForm({ title: branch ? 'Edit branch' : 'Add branch', submitLabel: branch ? 'Save branch' : 'Create branch', fields: [
    { key: 'name', label: 'Name', value: branch?.name, required: true }, { key: 'code', label: 'Code', value: branch?.code, required: true },
    { key: 'address', label: 'Address', value: branch?.address ?? '' }, { key: 'phone', label: 'Phone', value: branch?.phone ?? '' },
    { key: 'email', label: 'Email', type: 'email', value: branch?.email ?? '' }, { key: 'timezone', label: 'Timezone override', value: branch?.timezone ?? '' },
    { key: 'is_primary', label: 'Primary branch', type: 'select', value: String(branch?.is_primary ?? false), options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }] },
  ], onSubmit: async (values) => { await controlPlane.command('branch.save', { ...values, id: branch?.id ?? '', organization_id: shop.id }); toastSuccess(branch ? 'Branch updated' : 'Branch created'); reload() } })
}

function editStaff(shop: DeveloperShop, staff: DeveloperStaff | null, reload: () => void): void {
  openForm({ title: staff ? 'Edit staff access' : 'Add staff', description: 'An existing email is linked; a new email requires a password of at least 8 characters.', fields: [
    { key: 'email', label: 'Email', type: 'email', value: staff?.email, required: true }, { key: 'name', label: 'Name', value: staff?.name ?? '' },
    { key: 'password', label: staff ? 'New password (optional)' : 'Password for a new user', type: 'password' },
    { key: 'role_id', label: 'Role', type: 'select', value: staff?.roles[0]?.id ?? shop.roles?.[0]?.id ?? '', options: (shop.roles ?? []).map((r) => ({ value: r.id, label: r.name })), required: true },
    { key: 'branch_id', label: 'Branch scope', type: 'select', value: staff?.roles[0]?.branch_id ?? '', options: [{ value: '', label: 'All branches' }, ...(shop.branches ?? []).filter((b) => !b.deleted_at).map((b) => ({ value: b.id, label: b.name }))] },
  ], onSubmit: async (values) => {
    if (staff) await controlPlane.command('user.save', { id: staff.user_id, email: values.email, name: values.name, password: values.password })
    await controlPlane.command('staff.save', { ...values, user_id: staff?.user_id ?? '', organization_id: shop.id })
    toastSuccess(staff ? 'Staff access updated' : 'Staff added')
    reload()
  } })
}

function openShopSupport(shop: DeveloperShop, branch: DeveloperBranch | null = null): void {
  openForm({
    title: branch ? `Open ${branch.name} as developer` : `Open ${shop.name} as developer`,
    description: 'This creates a 30-minute full-access support session. The shop UI shows a persistent warning and every action remains attributed to your developer account.',
    submitLabel: 'Start support session',
    fields: [
      { key: 'reason', label: 'Reason for access', type: 'textarea', required: true },
      { key: 'ticket', label: 'Ticket or reference (optional)' },
    ],
    onSubmit: async ({ reason, ticket }) => {
      await controlPlane.startSupport(shop.id, reason ?? '', ticket ?? '')
      rememberActiveOrganization(shop.id)
      if (branch) {
        try { localStorage.setItem(`mekholi.activeBranch.${shop.id}`, branch.id) } catch { /* private mode */ }
      }
      window.location.assign(routeHref('/'))
    },
  })
}

export function developerShopView(id: string): HTMLElement {
  const { root, body, actions } = page('Shop', 'Full tenant administration. Every change is recorded in the platform audit log.')
  let shop: DeveloperShop | null = null
  const load = async () => {
    mount(body, h('div', { class: 'flex justify-center p-12' }, spinner()))
    try {
      shop = await controlPlane.shop(id)
      const current = shop
      mount(actions,
        button('Open shop dashboard', { variant: 'primary', icon: 'open_in_new', onClick: () => openShopSupport(current) }),
        button('Edit shop', { variant: 'secondary', icon: 'edit', onClick: () => openForm({ title: 'Edit shop', fields: [
          { key: 'name', label: 'Name', value: current.name, required: true }, { key: 'slug', label: 'Slug', value: current.slug, required: true },
          { key: 'shop_type', label: 'Shop type', value: current.shop_type ?? '' }, { key: 'currency', label: 'Currency', value: current.currency, required: true },
          { key: 'timezone', label: 'Timezone', value: current.timezone, required: true }, { key: 'locale', label: 'Locale', value: current.locale ?? 'en' },
          { key: 'status', label: 'Status', type: 'select', value: current.status ?? 'active', options: ['active','suspended','closed'].map((value) => ({ value, label: value })) },
        ], onSubmit: async (values) => { await controlPlane.command('shop.update', { ...values, id }); toastSuccess('Shop updated'); void load() } }) }),
        button('Delete shop', { variant: 'danger', icon: 'delete', onClick: () => openForm({ title: 'Permanently delete shop', description: `Type “${current.slug}” and provide a reason. This deletes all tenant business data.`, danger: true, submitLabel: 'Delete permanently', fields: [
          { key: 'confirm', label: 'Shop slug', required: true }, { key: 'reason', label: 'Reason', type: 'textarea', required: true },
        ], onSubmit: async (values) => { await controlPlane.command('shop.delete', { ...values, id }); toastSuccess('Shop deleted'); window.history.back() } }) }))
      mount(body,
        h('div', { class: 'grid gap-3 md:grid-cols-2 xl:grid-cols-4' },
          card(h('p', { class: 'text-xs text-content-muted', text: 'Organization' }), h('p', { class: 'mt-1 text-lg font-semibold', text: current.name }), h('p', { class: 'mt-1 text-xs font-mono text-content-subtle', text: current.id })),
          card(h('p', { class: 'text-xs text-content-muted', text: 'Profile' }), h('p', { class: 'mt-1 font-medium', text: current.shop_type ?? 'Unspecified' }), h('p', { class: 'text-xs text-content-subtle', text: `${current.currency} · ${current.timezone}` })),
          card(h('p', { class: 'text-xs text-content-muted', text: 'Status' }), h('div', { class: 'mt-2' }, badge(current.status ?? 'active', { tone: current.status === 'active' ? 'success' : 'warning' }))),
          card(h('p', { class: 'text-xs text-content-muted', text: 'Infrastructure' }), h('p', { class: 'mt-1 text-2xl font-semibold', text: `${current.warehouse_count ?? 0} / ${current.register_count ?? 0}` }), h('p', { class: 'text-xs text-content-subtle', text: 'warehouses / registers' }))),
        h('section', { class: 'rounded-xl border border-border bg-surface' },
          h('div', { class: 'flex items-center justify-between border-b border-border p-4' }, h('h2', { class: 'font-semibold', text: `Branches (${current.branch_count})` }), button('Add branch', { variant: 'secondary', icon: 'add', onClick: () => editBranch(current, null, () => void load()) })),
          ...((current.branches ?? []).map((branch) => h('div', { class: `flex flex-wrap items-center gap-3 border-b border-border p-4 last:border-0 ${branch.deleted_at ? 'opacity-50' : ''}` },
            h('div', { class: 'min-w-0 flex-1' }, h('p', { class: 'font-medium', text: branch.name }), h('p', { class: 'text-xs text-content-subtle', text: `${branch.code}${branch.address ? ` · ${branch.address}` : ''}` })),
            branch.is_primary ? badge('Primary', { tone: 'success' }) : null,
            !branch.deleted_at ? button('Open shop', { variant: 'primary', onClick: () => openShopSupport(current, branch) }) : null,
            button('Edit', { variant: 'ghost', onClick: () => editBranch(current, branch, () => void load()) }),
            !branch.deleted_at && !branch.is_primary ? button('Remove', { variant: 'danger', onClick: () => { if (confirm(`Remove branch “${branch.name}”?`)) void controlPlane.command('branch.delete', { organization_id: id, id: branch.id }).then(() => { toastSuccess('Branch removed'); void load() }).catch((e: unknown) => toastError(e instanceof Error ? e.message : String(e))) } }) : null))),
        ),
        h('section', { class: 'rounded-xl border border-border bg-surface' },
          h('div', { class: 'flex items-center justify-between border-b border-border p-4' }, h('h2', { class: 'font-semibold', text: `Staff (${current.staff_count})` }), button('Add staff', { variant: 'secondary', icon: 'person_add', onClick: () => editStaff(current, null, () => void load()) })),
          ...((current.staff ?? []).map((staff) => h('div', { class: 'flex flex-wrap items-center gap-3 border-b border-border p-4 last:border-0' },
            h('div', { class: 'min-w-0 flex-1' }, h('p', { class: 'font-medium', text: staff.name || staff.email }), h('p', { class: 'text-xs text-content-subtle', text: `${staff.email} · ${staff.roles.map((r) => r.name).join(', ') || 'No role'}` })),
            button('Edit', { variant: 'ghost', onClick: () => editStaff(current, staff, () => void load()) }),
            button('Remove', { variant: 'danger', onClick: () => { if (confirm(`Remove ${staff.email} from this shop?`)) void controlPlane.command('staff.remove', { organization_id: id, user_id: staff.user_id }).then(() => { toastSuccess('Staff removed'); void load() }).catch((e: unknown) => toastError(e instanceof Error ? e.message : String(e))) } }))))),
        h('section', { class: 'rounded-xl border border-border bg-surface' },
          h('div', { class: 'flex items-center justify-between border-b border-border p-4' }, h('h2', { class: 'font-semibold', text: 'Installed plugins' }), button('Install plugin', { variant: 'secondary', icon: 'add', onClick: () => void controlPlane.plugins().then((packages) => openForm({ title: 'Install plugin', fields: [{ key: 'key', label: 'Package', type: 'select', options: packages.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })) }], onSubmit: async ({ key }) => { await controlPlane.command('plugin.installation.set', { organization_id: id, key, enabled: true }); toastSuccess('Plugin installed'); void load() } })) })),
          ...((current.plugins?.length ? current.plugins.map((plugin) => h('div', { class: 'flex flex-wrap items-center gap-3 border-b border-border p-4 last:border-0' },
            h('div', { class: 'min-w-0 flex-1' }, h('p', { class: 'font-medium', text: plugin.key }), h('p', { class: 'text-xs text-content-subtle', text: `v${plugin.version}` })),
            badge(plugin.enabled ? 'Enabled' : 'Disabled', { tone: plugin.enabled ? 'success' : 'neutral' }),
            button(plugin.enabled ? 'Disable' : 'Enable', { variant: 'secondary', onClick: () => void controlPlane.command('plugin.installation.set', { organization_id: id, key: plugin.key, enabled: !plugin.enabled }).then(() => { toastSuccess('Plugin updated'); void load() }).catch((e: unknown) => toastError(e instanceof Error ? e.message : String(e))) }),
            button('Remove data', { variant: 'danger', onClick: () => { if (confirm(`Permanently remove ${plugin.key} and its stored plugin data?`)) void controlPlane.command('plugin.installation.remove', { organization_id: id, key: plugin.key }).then(() => { toastSuccess('Plugin removed'); void load() }).catch((e: unknown) => toastError(e instanceof Error ? e.message : String(e))) } }))) : [h('p', { class: 'p-4 text-sm text-content-muted', text: 'No plugins installed.' })])))
      )
    } catch (e) { failure(body, e) }
  }
  void load()
  return root
}

function pluginForm(plugin: DeveloperPlugin | null, reload: () => void): void {
  openForm({ title: plugin ? 'Edit plugin package' : 'Add plugin package', description: 'Catalogue metadata does not ship frontend code or migrations; those remain reviewed source deployments.', fields: [
    { key: 'key', label: 'Plugin key', value: plugin?.key, required: true }, { key: 'name', label: 'Name', value: plugin?.name, required: true },
    { key: 'category', label: 'Category', type: 'select', value: plugin?.category ?? 'optional', options: ['core','optional','industry'].map((value) => ({ value, label: value })) },
    { key: 'version', label: 'Version', value: plugin?.version ?? '1.0.0', required: true }, { key: 'core_api_version', label: 'Core API version', value: plugin?.core_api_version ?? '1', required: true },
    { key: 'description', label: 'Description', type: 'textarea', value: plugin?.description ?? '' },
    { key: 'dependencies', label: 'Dependencies (comma separated)', value: csv((plugin as DeveloperPlugin & { dependencies?: string[] })?.dependencies) },
    { key: 'conflicts', label: 'Conflicts (comma separated)', value: csv((plugin as DeveloperPlugin & { conflicts?: string[] })?.conflicts) },
  ], onSubmit: async (values) => {
    await controlPlane.command('plugin.package.save', { ...values, key: plugin?.key ?? values.key, dependencies: csvArray(values.dependencies ?? ''), conflicts: csvArray(values.conflicts ?? '') })
    toastSuccess(plugin ? 'Plugin package updated' : 'Plugin package created')
    reload()
  } })
}

export function developerPluginsView(): HTMLElement {
  const { root, body, actions } = page('Plugin catalogue', 'Create, edit and remove server package metadata; manage installations from each shop.')
  const load = async () => {
    try {
      const plugins = await controlPlane.plugins()
      mount(actions, button('Add plugin', { variant: 'primary', icon: 'add', onClick: () => pluginForm(null, () => void load()) }))
      mount(body, h('div', { class: 'grid gap-3 lg:grid-cols-2' }, ...plugins.map((p) => card(
        h('div', { class: 'flex items-start justify-between gap-3' }, h('div', null, h('h2', { class: 'font-semibold text-content', text: p.name }), h('p', { class: 'text-xs font-mono text-content-subtle', text: `${p.key} · v${p.version}` })), badge(p.category, { tone: 'neutral' })),
        h('p', { class: 'mt-2 text-sm text-content-muted', text: p.description ?? 'No description' }),
        h('div', { class: 'mt-3 grid grid-cols-4 gap-2 text-center text-xs' }, ...[[p.installed_shops,'Installed'],[p.enabled_shops,'Enabled'],[p.permission_count,'Permissions'],[p.migration_count,'Migrations']].map(([v,l]) => h('div', { class: 'rounded-md bg-surface-muted p-2' }, h('p', { class: 'text-lg font-semibold tabular-nums', text: String(v) }), h('p', { class: 'text-content-subtle', text: String(l) })))),
        h('div', { class: 'mt-3 flex gap-2' }, button('Edit', { variant: 'secondary', onClick: () => pluginForm(p, () => void load()) }), button('Delete', { variant: 'danger', disabled: p.installed_shops > 0, onClick: () => openForm({ title: 'Delete plugin package', danger: true, description: `Type “${p.key}”. Installed packages cannot be deleted.`, fields: [{ key: 'confirm', label: 'Plugin key', required: true }], onSubmit: async (values) => { await controlPlane.command('plugin.package.delete', { key: p.key, ...values }); toastSuccess('Plugin package deleted'); void load() } }) })),
        p.error_shops > 0 ? h('p', { class: 'mt-2 text-xs text-danger', text: `${p.error_shops} shop(s) need attention` }) : null))))
    } catch (e) { failure(body, e) }
  }
  void load()
  return root
}

function userForm(user: DeveloperUser | null, reload: () => void): void {
  openForm({ title: user ? 'Edit user' : 'Create user', description: user ? 'Leave password empty to keep the current password.' : 'The account is email-confirmed and can sign in immediately.', fields: [
    { key: 'email', label: 'Email', type: 'email', value: user?.email, required: true }, { key: 'name', label: 'Name', value: user?.name ?? '' },
    { key: 'password', label: user ? 'New password (optional)' : 'Password', type: 'password', required: !user },
  ], onSubmit: async (values) => { await controlPlane.command('user.save', { ...values, id: user?.id ?? '' }); toastSuccess(user ? 'User updated' : 'User created'); reload() } })
}

export function developerUsersView(): HTMLElement {
  const { root, body, actions } = page('Users', 'Manage authentication accounts and inspect tenant membership.')
  actions.append(button('Create user', { variant: 'primary', icon: 'person_add', onClick: () => userForm(null, () => void load()) }))
  const search = input({ type: 'search', placeholder: 'Search email, name or user ID…' })
  let timer = 0
  const load = async () => {
    try {
      const users = await controlPlane.users(search.value)
      mount(body, search, users.length ? h('div', { class: 'overflow-hidden rounded-xl border border-border bg-surface' }, ...users.map((user) => h('div', { class: 'flex flex-wrap items-center gap-3 border-b border-border p-4 last:border-0' },
        h('div', { class: 'min-w-0 flex-1' }, h('p', { class: 'font-medium', text: user.name || user.email }), h('p', { class: 'text-xs text-content-subtle', text: `${user.email} · ${user.id}` })),
        badge(`${user.organization_count} shop${user.organization_count === 1 ? '' : 's'}`, { tone: 'neutral' }), user.is_developer ? badge('Developer', { tone: 'warning' }) : null,
        button('Edit', { variant: 'ghost', onClick: () => userForm(user, () => void load()) }),
        button('Delete', { variant: 'danger', onClick: () => openForm({ title: 'Permanently delete user', danger: true, description: `Type “${user.email}” and provide a reason. All memberships are removed.`, fields: [{ key: 'confirm', label: 'Email', required: true }, { key: 'reason', label: 'Reason', type: 'textarea', required: true }], onSubmit: async (values) => { await controlPlane.command('user.delete', { id: user.id, ...values }); toastSuccess('User deleted'); void load() } }) })))) : emptyState('No users match', { iconName: 'person_search' }))
    } catch (e) { failure(body, e) }
  }
  search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 250) })
  void load()
  return root
}

export function developerLogsView(): HTMLElement {
  const { root, body } = page('Platform logs', 'Structured control-plane and worker events. Sensitive payloads are not exposed.')
  void controlPlane.logs().then((logs) => mount(body, logs.length ? h('div', { class: 'overflow-hidden rounded-xl border border-border bg-surface' }, ...logs.map((l) => h('div', { class: 'grid gap-2 border-b border-border p-4 last:border-0 sm:grid-cols-[10rem_7rem_1fr]' }, h('p', { class: 'text-xs text-content-subtle', text: new Date(l.occurred_at).toLocaleString() }), badge(l.severity, { tone: l.severity === 'error' || l.severity === 'critical' ? 'danger' : l.severity === 'warning' ? 'warning' : 'neutral' }), h('div', null, h('p', { class: 'text-sm font-medium', text: l.action }), h('p', { class: 'text-sm text-content-muted', text: l.message }), h('p', { class: 'text-xs text-content-subtle', text: [l.organization_name,l.plugin_key,l.correlation_id].filter(Boolean).join(' · ') }))))) : emptyState('No platform logs yet', { description: 'The telemetry store is ready; events appear when server-side ingestion is connected.', iconName: 'terminal' }))).catch((e) => failure(body, e))
  return root
}
