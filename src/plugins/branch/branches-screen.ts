/**
 * The branches screen: the list, the activity, the open-a-branch dialog.
 *
 * Built for the owner standing in the main branch asking about the other
 * one. Each row answers today and the week without a tap; the dialog asks
 * only what a branch *is* (name, code, address, phone) because the floor
 * and the first counter are created server-side with it — a branch
 * arrives ready to sell, or it does not arrive at all.
 */

import { h, mount } from '../../components/ui/h'
import { badge, card, cardHeader, emptyState } from '../../components/ui/card'
import { button, spinner } from '../../components/ui/button'
import { checkbox, field, input } from '../../components/ui/input'
import { modal } from '../../components/feedback/modal'
import { toastSuccess } from '../../components/feedback/toast'
import { formatMoney, minor } from '../../shared/domain/money'
import type { PluginDb } from '../../shared/registry/plugin-types'

export interface BranchActivity {
  id: string
  name: string
  code: string
  address: string | null
  phone: string | null
  is_primary: boolean
  registers: number
  today_sales: number
  today_total_minor: number
  week_sales: number
  week_total_minor: number
  open_dues_minor: number
}

export interface BranchesScreenOptions {
  db: PluginDb
  currency: string
}

export function createBranchesScreen(options: BranchesScreenOptions): HTMLElement {
  const { db, currency } = options

  const root = h('div', { class: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-4' })
  const listSlot = h('div', {})

  async function reload(): Promise<void> {
    mount(listSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    let branches: BranchActivity[]
    try {
      branches = await db.rpc<BranchActivity[]>('list', {})
    } catch (error) {
      mount(
        listSlot,
        h('p', {
          class: 'rounded-lg border border-border bg-surface p-4 text-sm text-danger',
          text: error instanceof Error ? error.message : 'The branches could not be read.',
        })
      )
      return
    }

    if (branches.length === 0) {
      mount(listSlot, emptyState('No branches', { iconName: 'store' }))
      return
    }

    mount(
      listSlot,
      h(
        'div',
        { class: 'flex flex-col gap-3' },
        ...branches.map((branch) =>
          card(
            cardHeader(branch.name, {
              subtitle: [branch.code, branch.address ?? undefined, branch.phone ?? undefined]
                .filter(Boolean)
                .join(' · '),
              iconName: 'store',
              actions: [
                branch.is_primary ? badge('Main branch', { tone: 'success', iconName: 'home' }) : null,
                button('Edit', {
                  size: 'sm',
                  variant: 'outline',
                  icon: 'edit',
                  onClick: () => openForm(branch),
                }),
              ],
            }),
            h(
              'div',
              { class: 'grid grid-cols-2 gap-3 sm:grid-cols-4' },
              figure('Today', formatMoney(minor(branch.today_total_minor), { currency }), `${branch.today_sales} sale${branch.today_sales === 1 ? '' : 's'}`),
              figure('Last 7 days', formatMoney(minor(branch.week_total_minor), { currency }), `${branch.week_sales} sale${branch.week_sales === 1 ? '' : 's'}`),
              figure('Dues out', formatMoney(minor(branch.open_dues_minor), { currency }), branch.open_dues_minor > 0 ? 'still to collect' : 'all clear'),
              figure('Counters', String(branch.registers), branch.registers === 1 ? 'register' : 'registers')
            )
          )
        )
      )
    )
  }

  function figure(label: string, value: string, hint: string): HTMLElement {
    return h(
      'div',
      { class: 'rounded-lg border border-border p-3' },
      h('p', { class: 'text-xs text-content-muted', text: label }),
      h('p', { class: 'text-lg font-semibold tabular-nums text-content', text: value }),
      h('p', { class: 'text-xs text-content-subtle', text: hint })
    )
  }

  function openForm(existing: BranchActivity | null): void {
    const nameBox = input({ value: existing?.name ?? '', placeholder: 'Uttara branch' })
    const codeBox = input({ value: existing?.code ?? '', placeholder: 'UTT', maxlength: 12 })
    const addressBox = input({ value: existing?.address ?? '' })
    const phoneBox = input({ value: existing?.phone ?? '', inputmode: 'tel' })
    const primaryBox = checkbox({
      label: 'Make this the main branch',
      checked: existing?.is_primary ?? false,
    })
    const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const submit = button(existing ? 'Save changes' : 'Open branch', {
      variant: 'primary',
      fullWidth: true,
      size: 'lg',
      onClick: () => void save(),
    })

    const dialog = modal({
      title: existing ? `Edit ${existing.name}` : 'Open a branch',
      ...(existing
        ? {}
        : {
            subtitle:
              'The retail floor and the first counter are created with it — it can sell tomorrow morning.',
          }),
      iconName: 'store',
      size: 'sm',
      footer: [h('div', { class: 'w-full' }, submit)],
    })

    mount(
      dialog.body,
      h(
        'div',
        { class: 'space-y-4' },
        field('Name', nameBox, { required: true }),
        field('Code', codeBox, {
          required: true,
          hint: 'Short and unique — it prefixes the branch’s floor and counter codes.',
        }),
        field('Address', addressBox),
        field('Phone', phoneBox),
        primaryBox,
        errorSlot
      )
    )

    async function save(): Promise<void> {
      submit.disabled = true
      errorSlot.classList.add('hidden')
      try {
        await db.rpc('save', {
          ...(existing ? { id: existing.id } : {}),
          name: nameBox.value.trim(),
          code: codeBox.value.trim().toUpperCase(),
          address: addressBox.value.trim(),
          phone: phoneBox.value.trim(),
          is_primary: primaryBox.querySelector('input')?.checked ?? false,
        })
        dialog.close()
        toastSuccess(existing ? 'Branch saved.' : 'Branch opened — its floor and counter are ready.')
        void reload()
      } catch (error) {
        submit.disabled = false
        errorSlot.textContent = error instanceof Error ? error.message : 'The branch was not saved.'
        errorSlot.classList.remove('hidden')
      }
    }
  }

  root.append(
    h(
      'div',
      { class: 'flex items-center justify-between gap-3' },
      h('p', {
        class: 'text-sm text-content-muted',
        text: 'Every branch, and what it did — watched from wherever you are.',
      }),
      button('Open a branch', { variant: 'primary', icon: 'add_business', onClick: () => openForm(null) })
    ),
    listSlot
  )
  void reload()
  return root
}
