/** Staff access management (Phase 4). */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { badge, emptyState } from '../../components/ui/card'
import { field, input, select } from '../../components/ui/input'
import { confirm, modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { can } from '../../app/state/session'
import { translateError } from '../../app/platform/errors'
import type { RoleRow, StaffRow } from '../../shared/repositories/contracts'

export function usersView(): HTMLElement {
  const repos = getRepositories()
  let staff: StaffRow[] = []
  let roles: RoleRow[] = []
  let branches: { id: string; name: string; code: string | null; is_primary: boolean }[] = []
  let loading = true

  const root = h('div', { class: 'p-3 sm:p-6' })
  const content = h('div', { class: 'mx-auto max-w-4xl space-y-4' })

  function render(): void {
    if (loading) {
      mount(content, h('div', { class: 'flex justify-center p-12' }, spinner()))
      return
    }
    const add = can('users.create') ? button('Add staff', { variant: 'primary', icon: 'person_add', onClick: () => openAdd() }) : null
    mount(content,
      h('div', { class: 'flex flex-wrap items-end justify-between gap-3' },
        h('div', {},
          h('h1', { class: 'text-lg font-semibold text-content', text: 'Staff' }),
          h('p', { class: 'mt-1 text-sm text-content-muted', text: 'Create logins yourself — set the email and password, hand them over, done.' })
        ),
        add
      ),
      staff.length > 0
        ? h('div', { class: 'divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface' }, ...staff.map((row) => staffRow(row)))
        : emptyState('No staff yet', { description: 'Add a cashier, manager or accountant to start sharing the shop.', iconName: 'group', action: add })
    )
  }

  function staffRow(row: StaffRow): HTMLElement {
    const roleText = row.roles.map((role) => role.name).join(', ') || 'No role'
    const branchText = row.branches.length > 0 ? row.branches.map((branch) => branch.name).join(', ') : 'All branches'
    return h('div', { class: 'flex flex-wrap items-center gap-3 p-4' },
      h('div', { class: 'flex min-w-0 flex-1 items-center gap-3' },
        h('div', { class: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary', text: row.name.charAt(0).toUpperCase() }),
        h('div', { class: 'min-w-0' },
          h('p', { class: 'truncate font-medium text-content', text: row.name }),
          h('p', { class: 'truncate text-sm text-content-muted', text: row.email }),
          h('p', { class: 'truncate text-xs text-content-subtle', text: `${roleText} · ${branchText}` })
        )
      ),
      h('div', { class: 'flex items-center gap-2' },
        badge(row.kind === 'pending' ? 'Invite pending' : row.isActive ? 'Active' : 'Disabled', { tone: row.kind === 'pending' ? 'warning' : row.isActive ? 'success' : 'neutral' }),
        row.kind === 'member' && can('users.edit') ? button('Edit role', { variant: 'ghost', onClick: () => openRoles(row) }) : null,
        row.kind === 'member' && can('users.delete') ? button('Remove', { variant: 'ghost', onClick: () => void remove(row) }) : null
      )
    )
  }

  function openAdd(): void {
    const name = input({ autofocus: true, placeholder: 'Rahima Khatun' })
    const email = input({ type: 'email', placeholder: 'cashier@example.com' })
    const password = input({ placeholder: 'At least 8 characters', autocomplete: 'off' })
    const generate = button('Generate', { variant: 'ghost', icon: 'casino', onClick: () => { password.value = generatePassword() } })
    const role = select({ options: roles.map((item) => ({ value: item.id, label: item.name })), placeholder: 'Choose a role…' })
    const branch = select({ options: branches.map((item) => ({ value: item.id, label: item.name })), placeholder: 'All branches' })
    const error = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const save = button('Create account', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({ title: 'Add staff', subtitle: 'No confirmation email — the account works the moment you create it.', iconName: 'person_add', size: 'sm', footer: [h('div', { class: 'w-full' }, save)] })
    dialog.body.replaceChildren(h('div', { class: 'space-y-4' },
      field('Full name', name),
      field('Email address', email, { required: true, hint: 'This is their sign-in name; it does not need a real inbox.' }),
      field('Password', h('div', { class: 'flex items-stretch gap-2' }, h('div', { class: 'flex-1' }, password), generate), { required: true, hint: 'Share it with them yourself — it is shown only here.' }),
      field('Role', role, { required: true }),
      field('Branch access', branch, { hint: 'Leave blank to grant access to every branch.' }),
      error
    ))
    save.addEventListener('click', () => {
      void (async () => {
        if (!email.value.includes('@') || !role.value || password.value.length < 8) {
          error.textContent = 'Enter a valid email, a password of at least 8 characters, and choose a role.'
          error.classList.remove('hidden')
          return
        }
        save.disabled = true
        try {
          const made = await repos.organization.createStaff(email.value.trim(), password.value, name.value.trim(), role.value, branch.value || null)
          dialog.close()
          toastSuccess(made.created
            ? `Account ready. ${made.email} can sign in with that password right now.`
            : `${made.email} already had a login — it now has access to this shop.`)
          await reload()
        } catch (err) {
          error.textContent = translateError(err).message
          error.classList.remove('hidden')
          save.disabled = false
        }
      })()
    })
  }

  function openRoles(row: StaffRow): void {
    const role = select({ options: roles.map((item) => ({ value: item.id, label: item.name })), value: row.roles[0]?.id, placeholder: 'No role' })
    const branch = select({ options: branches.map((item) => ({ value: item.id, label: item.name })), value: row.branches[0]?.id, placeholder: 'All branches' })
    const error = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const save = button('Save access', { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({ title: `Access for ${row.name}`, iconName: 'admin_panel_settings', size: 'sm', footer: [h('div', { class: 'w-full' }, save)] })
    dialog.body.replaceChildren(h('div', { class: 'space-y-4' }, field('Role', role, { required: true }), field('Branch access', branch, { hint: 'Leave blank for all branches.' }), error))
    save.addEventListener('click', () => {
      void (async () => {
        if (!role.value || !row.userId) return
        save.disabled = true
        try {
          await repos.organization.setStaffRoles(row.userId, [role.value], branch.value || null)
          dialog.close()
          toastSuccess('Staff access updated')
          await reload()
        } catch (err) {
          error.textContent = translateError(err).message
          error.classList.remove('hidden')
          save.disabled = false
        }
      })()
    })
  }

  async function remove(row: StaffRow): Promise<void> {
    if (!row.userId) return
    const yes = await confirm(`Remove ${row.name}?`, { message: 'They will lose access to this shop, but their auth account and audit history remain.', confirmLabel: 'Remove access', tone: 'danger', iconName: 'person_remove' })
    if (!yes) return
    try {
      await repos.organization.removeStaff(row.userId)
      toastSuccess('Access removed')
      await reload()
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  async function reload(): Promise<void> {
    loading = true
    render()
    try {
      ;[staff, roles, branches] = await Promise.all([
        repos.organization.listStaff(),
        repos.organization.listRoles(),
        repos.organization.listBranches(),
      ])
    } catch (error) {
      mount(content, emptyState('Staff could not be loaded', { description: translateError(error).message, iconName: 'error' }))
    } finally {
      loading = false
      render()
    }
  }

  void reload()
  mount(root, content)
  return root
}

/**
 * A password worth reading over the counter: unambiguous characters only
 * (no 0/O, 1/l/I), long enough that the 8-character floor is comfortably
 * cleared, random from the platform's CSPRNG rather than Math.random.
 */
export function generatePassword(length = 12): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('')
}

export default usersView
