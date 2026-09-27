/**
 * The due book screen: everyone who owes, biggest debt first.
 *
 * Deliberately a *book*, not a workflow. Collection already lives where
 * the money changes hands — the customer card's "Collect due" — and a
 * second collect path here would mean two dialogs to keep honest. This
 * screen answers the standing questions instead: how much is out, with
 * whom, across how many invoices, and since when. The row points the way
 * to the customer screen where the collecting happens.
 */

import { h, icon, mount } from '../../components/ui/h'
import { badge, card, emptyState } from '../../components/ui/card'
import { spinner } from '../../components/ui/button'
import { searchInput } from '../../components/ui/input'
import { formatMoney, minor } from '../../shared/domain/money'
import type { PluginDb } from '../../shared/registry/plugin-types'

interface Debtor {
  id: string
  name: string
  phone: string | null
  balance_minor: number
  credit_limit_minor: number
  open_sales: number
  oldest_due_at: string | null
}

interface DueBook {
  total_due_minor: number
  debtor_count: number
  debtors: Debtor[]
}

export interface DueScreenOptions {
  db: PluginDb
  currency: string
}

export function createDueScreen(options: DueScreenOptions): HTMLElement {
  const { db, currency } = options

  const root = h('div', { class: 'mx-auto flex w-full max-w-3xl flex-col gap-4 p-4' })
  const headSlot = h('div', {})
  const listSlot = h('div', {})

  let search = ''

  async function reload(): Promise<void> {
    mount(listSlot, h('div', { class: 'flex justify-center p-6' }, spinner()))
    let book: DueBook
    try {
      book = await db.rpc<DueBook>('book', search ? { search } : {})
    } catch (error) {
      mount(
        listSlot,
        h('p', {
          class: 'rounded-lg border border-border bg-surface p-4 text-sm text-danger',
          text: error instanceof Error ? error.message : 'The due book could not be read.',
        })
      )
      return
    }

    mount(
      headSlot,
      card(
        h(
          'div',
          { class: 'flex items-baseline justify-between gap-3' },
          h(
            'div',
            {},
            h('p', { class: 'text-xs text-content-muted', text: 'Owed to the shop' }),
            h('p', {
              class: 'text-2xl font-semibold tabular-nums text-content',
              text: formatMoney(minor(book.total_due_minor), { currency }),
            })
          ),
          h('p', {
            class: 'text-xs text-content-muted',
            text:
              book.debtor_count === 0
                ? 'Nobody owes anything.'
                : `${book.debtor_count} customer${book.debtor_count === 1 ? '' : 's'} in the book`,
          })
        )
      )
    )

    if (book.debtors.length === 0) {
      mount(
        listSlot,
        emptyState(search ? 'Nobody matching that owes anything' : 'The book is clean', {
          description: search
            ? 'Try another name or phone number.'
            : 'A sale taken partly or fully on credit appears here, under the customer’s name.',
          iconName: 'menu_book',
        })
      )
      return
    }

    mount(
      listSlot,
      h(
        'div',
        { class: 'overflow-hidden rounded-xl border border-border bg-surface' },
        ...book.debtors.map((debtor) => {
          const since = debtor.oldest_due_at
            ? new Date(debtor.oldest_due_at).toLocaleDateString()
            : null
          return h(
            'div',
            {
              class:
                'flex min-h-[64px] items-center gap-3 border-b border-border p-3 last:border-b-0',
            },
            h(
              'div',
              { class: 'min-w-0 flex-1' },
              h('p', { class: 'truncate font-medium text-content', text: debtor.name }),
              h('p', {
                class: 'truncate text-xs text-content-muted',
                text: [
                  debtor.phone ?? undefined,
                  `${debtor.open_sales} open invoice${debtor.open_sales === 1 ? '' : 's'}`,
                  since ? `oldest ${since}` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · '),
              })
            ),
            h(
              'div',
              { class: 'flex shrink-0 items-center gap-2' },
              badge(formatMoney(minor(debtor.balance_minor), { currency }), { tone: 'warning' }),
              // Collection happens on the customer card, where the identity,
              // the history and the dialog already live.
              h(
                'a',
                {
                  href: '/customers',
                  class:
                    'flex items-center gap-1 text-xs text-content-muted hover:text-content',
                  'aria-label': `Collect from ${debtor.name} on the Customers screen`,
                },
                icon('arrow_forward', 'text-base'),
                'Customers'
              )
            )
          )
        })
      )
    )
  }

  root.append(
    searchInput('Search the book by name or phone…', (value) => {
      search = value.trim()
      void reload()
    }),
    headSlot,
    listSlot
  )
  void reload()
  return root
}
