/** Role and permission management (Phase 4). */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { badge, emptyState } from '../../components/ui/card'
import { checkbox, field, input } from '../../components/ui/input'
import { confirm, modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { can } from '../../app/state/session'
import { translateError } from '../../app/platform/errors'
import type { RoleRow } from '../../shared/repositories/contracts'

interface PermissionOption {
  id: string
  key: string
  label: string
  category: string
}

export function rolesView(): HTMLElement {
  const repos = getRepositories()
  let roles: RoleRow[] = []
  let permissions: PermissionOption[] = []
  let loading = true

  const root = h('div', { class: 'p-3 sm:p-6' })
  const content = h('div', { class: 'w-full space-y-4' })

  function render(): void {
    if (loading) {
      mount(content, h('div', { class: 'flex justify-center p-12' }, spinner()))
      return
    }
    const add = can('roles.create') || can('roles.manage') ? button('Create role', { variant: 'primary', icon: 'add', onClick: () => openForm(null) }) : null
    mount(content,
      h('div', { class: 'flex flex-wrap items-end justify-between gap-3' },
        h('div', {},
          h('h1', { class: 'text-lg font-semibold text-content', text: 'Roles' }),
          h('p', { class: 'mt-1 text-sm text-content-muted', text: 'Decide which parts of the shop each staff role can use.' })
        ),
        add
      ),
      roles.length > 0
        ? h('div', { class: 'grid gap-3 md:grid-cols-2' }, ...roles.map((role) => roleCard(role)))
        : emptyState('No roles yet', { description: 'Create a role for a cashier, manager or another trusted operator.', iconName: 'admin_panel_settings', action: add })
    )
  }

  function roleCard(role: RoleRow): HTMLElement {
    const edit = can('roles.edit') || can('roles.manage')
    const remove = can('roles.delete') || can('roles.manage')
    return h('div', { class: 'rounded-xl border border-border bg-surface p-4' },
      h('div', { class: 'flex items-start justify-between gap-3' },
        h('div', {},
          h('div', { class: 'flex items-center gap-2' }, h('h2', { class: 'font-semibold text-content', text: role.name }), role.isSystem ? badge('System', { tone: 'primary' }) : null),
          h('p', { class: 'mt-1 text-xs text-content-subtle', text: role.key })
        ),
        h('div', { class: 'flex gap-1' },
          edit ? button('Edit', { variant: 'ghost', onClick: () => openForm(role) }) : null,
          !role.isSystem && remove ? button('Delete', { variant: 'ghost', onClick: () => void removeRole(role) }) : null
        )
      ),
      h('div', { class: 'mt-3 flex flex-wrap gap-1.5' },
        ...role.permissionKeys.slice(0, 12).map((key) => badge(key, { tone: 'neutral' })),
        role.permissionKeys.length > 12 ? badge(`+${role.permissionKeys.length - 12} more`, { tone: 'neutral' }) : null,
        role.permissionKeys.length === 0 ? h('p', { class: 'text-sm text-content-muted', text: 'No permissions' }) : null
      )
    )
  }

  function openForm(existing: RoleRow | null): void {
    const name = input({ value: existing?.name ?? '', autofocus: true, placeholder: 'Store manager' })
    const key = input({ value: existing?.key ?? '', placeholder: 'store_manager', disabled: existing !== null })
    const search = input({ type: 'search', placeholder: 'Filter permissions…' })
    const error = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const permissionHost = h('div', { class: 'max-h-72 space-y-3 overflow-y-auto rounded-lg border border-border p-3' })
    const selected = new Set(existing?.permissionKeys ?? [])
    const save = button(existing ? 'Save role' : 'Create role', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({ title: existing ? 'Edit role' : 'Create role', subtitle: existing?.isSystem ? 'System role names cannot change, but permissions can.' : 'Choose the smallest set of access this role needs.', iconName: 'admin_panel_settings', size: 'lg', footer: [h('div', { class: 'w-full' }, save)] })

    function drawPermissions(): void {
      const needle = search.value.trim().toLowerCase()
      const shown = permissions.filter((permission) => `${permission.key} ${permission.label} ${permission.category}`.toLowerCase().includes(needle))
      const groups = new Map<string, PermissionOption[]>()
      for (const permission of shown) groups.set(permission.category, [...(groups.get(permission.category) ?? []), permission])
      mount(permissionHost, ...[...groups.entries()].map(([category, entries]) =>
        h('div', { class: 'space-y-1' },
          h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-content-subtle', text: category }),
          ...entries.map((permission) => {
            const control = checkbox({ label: `${permission.label} · ${permission.key}`, checked: selected.has(permission.key) })
            control.querySelector('input')?.addEventListener('change', (event) => {
              const checked = (event.target as HTMLInputElement).checked
              if (checked) selected.add(permission.key)
              else selected.delete(permission.key)
            })
            return control
          })
        )
      ))
    }

    search.addEventListener('input', drawPermissions)
    dialog.body.replaceChildren(h('div', { class: 'space-y-4' }, field('Role name', name, { required: true }), field('Role key', key, { required: true, hint: 'Stable key used in permissions and reports.' }), field('Filter permissions', search), permissionHost, error))
    drawPermissions()
    save.addEventListener('click', () => {
      void (async () => {
        if (!name.value.trim() || !key.value.trim()) {
          error.textContent = 'Enter a role name and key.'
          error.classList.remove('hidden')
          return
        }
        save.disabled = true
        try {
          const saved = existing
            ? await repos.organization.updateRole(existing.id, name.value.trim(), [...selected])
            : await repos.organization.createRole(name.value.trim(), key.value.trim(), [...selected])
          roles = existing ? roles.map((role) => role.id === saved.id ? saved : role) : [...roles, saved]
          dialog.close()
          render()
          toastSuccess(existing ? 'Role updated' : 'Role created')
        } catch (err) {
          error.textContent = translateError(err).message
          error.classList.remove('hidden')
          save.disabled = false
        }
      })()
    })
  }

  async function removeRole(role: RoleRow): Promise<void> {
    const yes = await confirm(`Delete ${role.name}?`, { message: 'Only unassigned custom roles can be deleted.', confirmLabel: 'Delete role', tone: 'danger', iconName: 'delete' })
    if (!yes) return
    try {
      await repos.organization.deleteRole(role.id)
      roles = roles.filter((item) => item.id !== role.id)
      render()
      toastSuccess('Role deleted')
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  async function load(): Promise<void> {
    try {
      ;[roles, permissions] = await Promise.all([repos.organization.listRoles(), repos.organization.listPermissions()])
    } catch (error) {
      mount(content, emptyState('Roles could not be loaded', { description: translateError(error).message, iconName: 'error' }))
    } finally {
      loading = false
      render()
    }
  }

  mount(root, content)
  void load()
  return root
}

export default rolesView
