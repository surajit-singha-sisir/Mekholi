/**
 * Dashboard (spec §21, §56, docs/09 #10).
 *
 * The first screen of the day, and the one the whole round-trip rule exists
 * for: **one call** — `dashboard_summary` — returns the eight widgets, the
 * trend lines, the rankings and the answers to the owner's morning questions.
 * Eight widgets as eight queries would be eight scans of `sales` and eight
 * chances to render a shop that never existed, with today's takings from one
 * moment and the drawer count from another.
 *
 * The order on the page is the order an owner asks in:
 *
 *   1. Did we take money today?        the widgets
 *   2. Is it going up or down?         the charts
 *   3. What should I do about it?      the answer cards, each linking to the
 *                                      screen that acts on it
 *
 * The Phase 1 platform vitals are still here, folded into a disclosure at the
 * bottom. They are evidence about the build, not about the shop, so they
 * belong behind a click (docs/03 §7, progressive disclosure).
 */

import { h, icon, mount } from '../../components/ui/h'
import { button, iconButton } from '../../components/ui/button'
import { badge, emptyState, skeleton, stat } from '../../components/ui/card'
import { barChart, donutChart, lineChart, sparkline, chartCard } from '../../components/ui/chart'
import { answersPanel, answerText } from '../analytics'
import { getRepositories } from '../../app/data'
import { activeOrganization, sessionStore } from '../../app/state/session'
import { salesFloor } from '../../app/state/sales-floor'
import { pluginWidgetsHost } from '../../app/plugin-slots'
import { formatMoney, minor, type Minor } from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { DashboardSummary } from '../../shared/repositories/contracts'
import type { PluginRegistry } from '../../shared/registry/plugin-registry'

export interface DashboardOptions {
  onNavigate?: (path: string) => void
}

export function dashboardView(registry: PluginRegistry, options: DashboardOptions = {}): HTMLElement {
  const repos = getRepositories()
  const session = sessionStore.state
  const org = activeOrganization()
  const onNavigate = options.onNavigate
  const currency = org?.currency ?? 'BDT'

  let summary: DashboardSummary | null = null
  let loading = false
  let requestId = 0

  const widgetsSlot = h('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' })
  const chartsSlot = h('div', { class: 'grid gap-3 lg:grid-cols-2' })
  const answersSlot = h('div', null)
  // Plugin widgets, below everything the shop itself reports (docs/03 §7).
  const pluginsSlot = pluginWidgetsHost(registry)
  const refreshButton = iconButton('refresh', 'Refresh the dashboard', { onClick: () => void load() })

  const root = h(
    'div',
    { class: 'w-full space-y-4 p-4 lg:p-6' },
    // Greeting
    h(
      'div',
      { class: 'flex flex-wrap items-end justify-between gap-3' },
      h(
        'div',
        { class: 'min-w-0' },
        h('h2', { class: 'text-xl font-semibold text-content', text: org ? org.name : 'Your shop' }),
        h('p', {
          class: 'mt-0.5 text-sm text-content-muted',
          text: `Signed in as ${session.email ?? '—'} · ${session.organizations.length} shop(s)`,
        })
      ),
      h(
        'div',
        { class: 'flex shrink-0 items-center gap-2' },
        ...session.organizations.flatMap((entry) => entry.role_names).map((role) =>
          badge(role, { tone: 'primary', iconName: 'shield' })
        ),
        refreshButton
      )
    ),
    widgetsSlot,
    chartsSlot,
    answersSlot,
    pluginsSlot,
    platformStatus(registry, session.permissions.length)
  )

  function money(value: Minor): string {
    return formatMoney(value, { currency })
  }

  function renderLoading(): void {
    mount(
      widgetsSlot,
      ...Array.from({ length: 8 }, () => h('div', { class: 'rounded-lg border border-border bg-surface p-4' }, skeleton('h-4 w-24'), skeleton('mt-3 h-7 w-32')))
    )
    mount(
      chartsSlot,
      ...Array.from({ length: 4 }, () => h('div', { class: 'rounded-lg border border-border bg-surface p-4' }, skeleton('h-4 w-32'), skeleton('mt-3 h-32 w-full')))
    )
    mount(answersSlot, null)
  }

  function renderSummary(): void {
    if (!summary) return
    const data = summary

    const days = data.trendDays.series
    const today = days[days.length - 1]
    const yesterday = days[days.length - 2]
    const takingsTrend = days.map((point) => point.value)
    const profitTrend = data.trendProfit.series.map((point) => point.value)
    const deltaVsYesterday =
      today && yesterday && yesterday.value > 0
        ? ((today.value - yesterday.value) / yesterday.value) * 100
        : null

    const margin = data.takings > 0 ? (data.grossProfit / data.takings) * 100 : 0
    const avgBill = data.orders > 0 ? data.takings / data.orders : 0

    // ── The eight widgets ──────────────────────────────────────────────
    mount(
      widgetsSlot,
      widgetCard({
        label: 'Takings today',
        value: money(data.takings),
        iconName: 'payments',
        hint: `${data.orders} bill(s) · average ${money(minor(Math.round(avgBill)))}`,
        delta: deltaVsYesterday,
        spark: takingsTrend.slice(-14),
      }),
      widgetCard({
        label: 'Profit today',
        value: money(data.grossProfit),
        iconName: 'trending_up',
        hint: `margin ${margin.toFixed(1)}% · after cost of goods`,
        delta: profitDelta(data),
        spark: profitTrend.slice(-14),
      }),
      widgetCard({
        label: 'Cash in the drawer',
        value: money(data.expectedCash),
        iconName: 'point_of_sale',
        hint: 'expected, from every open register session',
        onOpen: () => onNavigate?.('/register'),
      }),
      widgetCard({
        label: 'Expenses today',
        value: money(data.expenses),
        iconName: 'receipt_long',
        hint: `refunds today ${money(data.refunds)}`,
        onOpen: () => onNavigate?.('/expenses'),
      }),
      widgetCard({
        label: 'Stock on hand',
        value: money(data.stockValue),
        iconName: 'warehouse',
        hint: `${data.lowStock} low · ${data.outOfStock} out of stock`,
        onOpen: () => onNavigate?.('/stock'),
      }),
      widgetCard({
        label: 'Who owes us',
        value: answerValue(data, 'receivable', money),
        iconName: 'account_balance_wallet',
        hint: answerNote(data, 'receivable') ?? `${data.pendingPayments > 0 ? `${money(data.pendingPayments)} unpaid on bills` : 'no unpaid bills'}`,
        onOpen: () => onNavigate?.('/reports?report=customer&type=owing'),
      }),
      widgetCard({
        label: 'What we owe suppliers',
        value: answerValue(data, 'payable', money),
        iconName: 'local_shipping',
        hint: answerNote(data, 'payable') ?? 'supplier balances',
        onOpen: () => onNavigate?.('/reports?report=supplier&type=owing'),
      }),
      widgetCard({
        label: 'Needs reordering',
        value: answerValue(data, 'reorder', money),
        iconName: 'inventory_2',
        hint: answerNote(data, 'reorder') ?? `${data.lowStock} item(s) at or below their reorder point`,
        onOpen: () => onNavigate?.('/reports?report=low_stock'),
      })
    )

    // ── The charts ─────────────────────────────────────────────────────
    mount(
      chartsSlot,
      chartCard({
        title: 'Takings, last 30 days',
        subtitle: `Today ${money(data.takings)} against yesterday`,
        actions: button('Analyse', { variant: 'ghost', icon: 'monitoring', onClick: () => onNavigate?.('/analytics?measure=takings&dimension=day&period=month') }),
        body: lineChart(
          days.map((point) => ({ label: point.label, value: point.value, compare: point.prev })),
          { money: true, currency, ariaLabel: 'Takings per day for the last thirty days' }
        ),
      }),
      chartCard({
        title: 'Profit, last 30 days',
        subtitle: 'Revenue minus the cost of what was sold',
        actions: button('Analyse', { variant: 'ghost', icon: 'monitoring', onClick: () => onNavigate?.('/analytics?measure=profit&dimension=day&period=month') }),
        body: lineChart(
          data.trendProfit.series.map((point) => ({ label: point.label, value: point.value })),
          { money: true, currency, ariaLabel: 'Profit per day for the last thirty days' }
        ),
      }),
      chartCard({
        title: 'How customers paid today',
        subtitle: 'Split bills count once per method, so the shares are of the money received',
        actions: button('Analyse', { variant: 'ghost', icon: 'monitoring', onClick: () => onNavigate?.('/analytics?measure=takings&dimension=payment_method&period=day') }),
        body: donutChart(
          data.paymentMix.map((entry) => ({ label: entry.method, value: entry.total })),
          { currency, ariaLabel: 'Payment mix today', emptyMessage: 'No payments taken yet today' }
        ),
      }),
      chartCard({
        title: 'Busiest hours today',
        subtitle: 'When to have the second till open',
        actions: button('Analyse', { variant: 'ghost', icon: 'monitoring', onClick: () => onNavigate?.('/analytics?measure=takings&dimension=hour&period=day') }),
        body: barChart(
          data.salesByHour.map((entry) => ({ label: String(entry.hour).padStart(2, '0'), value: entry.total })),
          { money: true, currency, height: 150, ariaLabel: 'Takings by hour today', emptyMessage: 'No sales yet today' }
        ),
      }),
      chartCard({
        title: 'Best sellers this month',
        subtitle: 'By takings, with what each earned',
        actions: button('Report', { variant: 'ghost', icon: 'assessment', onClick: () => onNavigate?.('/reports?report=product_performance') }),
        body: barChart(
          data.rankProducts.series.slice(0, 6).map((point) => ({ label: point.label, value: point.value })),
          { money: true, currency, height: 180, ariaLabel: 'Top products by takings this month', emptyMessage: 'Nothing sold yet this month' }
        ),
      }),
      chartCard({
        title: 'Where the money comes from',
        subtitle: 'Takings by category this month',
        actions: button('Analyse', { variant: 'ghost', icon: 'monitoring', onClick: () => onNavigate?.('/analytics?measure=takings&dimension=category') }),
        body: donutChart(
          data.rankCategories.series.slice(0, 6).map((point) => ({ label: point.label, value: point.value })),
          { currency, ariaLabel: 'Takings by category this month', emptyMessage: 'No category sales yet' }
        ),
      }),
      chartCard({
        title: 'This year, month by month',
        subtitle: 'Takings per month',
        actions: button('Analyse', { variant: 'ghost', icon: 'monitoring', onClick: () => onNavigate?.('/analytics?measure=takings&dimension=month&period=year') }),
        body: barChart(
          data.trendMonths.series.map((point) => ({ label: point.label, value: point.value })),
          { money: true, currency, height: 150, ariaLabel: 'Takings by month this year', emptyMessage: 'No sales yet this year' }
        ),
      })
    )

    // ── The answers ────────────────────────────────────────────────────
    mount(answersSlot, answersPanel(data.answers, currency))
  }

  function profitDelta(data: DashboardSummary): number | null {
    const series = data.trendProfit.series
    const todayProfit = series[series.length - 1]
    const yesterdayProfit = series[series.length - 2]
    if (!todayProfit || !yesterdayProfit || yesterdayProfit.value === 0) return null
    return ((todayProfit.value - yesterdayProfit.value) / Math.abs(yesterdayProfit.value)) * 100
  }

  async function load(): Promise<void> {
    if (loading) return
    const branchId = salesFloor()?.branchId ?? null
    loading = true
    const ticket = ++requestId
    renderLoading()
    try {
      if (!branchId) throw new Error('No branch is available for this user')
      const next = await repos.analytics.dashboard({ branchId })
      // A slower first request must not overwrite a newer one.
      if (ticket !== requestId) return
      summary = next
      renderSummary()
    } catch (error) {
      if (ticket !== requestId) return
      summary = null
      mount(
        answersSlot,
        emptyState('The dashboard could not be loaded', {
          description: translateError(error).message,
          iconName: 'error',
          action: button('Try again', { variant: 'primary', icon: 'refresh', onClick: () => void load() }),
        })
      )
      mount(widgetsSlot, null)
      mount(chartsSlot, null)
    } finally {
      loading = false
    }
  }

  void load()
  return root
}

/** A widget tile: one number, its context, and its recent shape. */
function widgetCard(options: {
  label: string
  value: string
  iconName: string
  hint: string
  delta?: number | null
  spark?: readonly number[]
  onOpen?: () => void
}): HTMLElement {
  const tile = h(
    'div',
    {
      class:
        'rounded-lg border border-border bg-surface p-4 ' +
        (options.onOpen ? 'cursor-pointer transition-colors hover:border-primary/40' : ''),
    },
    h(
      'div',
      { class: 'flex items-start justify-between gap-2' },
      h('p', { class: 'text-xs font-medium text-content-muted', text: options.label }),
      icon(options.iconName, 'text-content-subtle text-lg shrink-0')
    ),
    h(
      'div',
      { class: 'mt-1 flex items-end justify-between gap-2' },
      h('p', {
        class: 'text-2xl font-semibold tabular-nums tracking-tight text-content',
        text: options.value,
      }),
      options.spark && options.spark.length > 1 ? sparkline(options.spark, { class: 'w-20 shrink-0 text-primary' }) : null
    ),
    h(
      'div',
      { class: 'mt-1 flex items-center gap-2' },
      options.delta === null || options.delta === undefined
        ? null
        : badge(`${options.delta >= 0 ? '+' : ''}${options.delta.toFixed(1)}%`, {
            tone: options.delta >= 0 ? 'success' : 'danger',
          }),
      h('p', { class: 'text-xs text-content-subtle', text: options.hint })
    )
  )
  if (options.onOpen) {
    const open = options.onOpen
    tile.addEventListener('click', () => open())
    tile.tabIndex = 0
    tile.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open()
    })
  }
  return tile
}

/** An answer's value, formatted for a widget. */
function answerValue(
  summary: DashboardSummary,
  id: string,
  money: (value: Minor) => string
): string {
  const answer = summary.answers.find((entry) => entry.id === id)
  if (!answer) return '—'
  return answer.kind === 'money' && answer.amount !== null
    ? money(answer.amount)
    : answerText(answer, summary.currency)
}

function answerNote(summary: DashboardSummary, id: string): string | null {
  return summary.answers.find((entry) => entry.id === id)?.note ?? null
}

/**
 * The Phase 1 vitals, kept but demoted.
 *
 * They answer "is the plugin architecture holding?" — a developer's question,
 * not a shopkeeper's — so they live behind a disclosure rather than competing
 * with the day's takings for attention.
 */
function platformStatus(registry: PluginRegistry, permissionCount: number): HTMLElement {
  const loaded = registry.list().filter((plugin) => plugin.status === 'loaded').length
  return h(
    'details',
    { class: 'rounded-lg border border-border bg-surface p-4' },
    h(
      'summary',
      { class: 'cursor-pointer text-sm font-medium text-content' },
      'Platform status'
    ),
    h(
      'div',
      { class: 'mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4' },
      stat('Plugins loaded', String(loaded), {
        iconName: 'extension',
        hint: `${registry.list().length} declared`,
      }),
      stat('Product fields', String(registry.productFields.items.length), {
        iconName: 'view_agenda',
        hint: 'all contributed by plugins',
      }),
      stat('Permissions held', String(permissionCount), {
        iconName: 'verified_user',
        hint: 'granted by your role',
      }),
      stat('Plugin nav items', String(registry.nav.items.length), {
        iconName: 'explore',
        hint: 'added to the sidebar with no feature edits',
      })
    )
  )
}
