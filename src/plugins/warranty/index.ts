/**
 * Warranty — behaviour.
 *
 * The plugin for shops that promise something about what they sell: a year on a
 * fridge, two years on a handset, the shop's own guarantee on a repair. The
 * core already knows a sale happened; this knows what the sale *promised*, to
 * whom, about which unit, until when — and what keeping those promises cost.
 *
 * Three ideas hold it together:
 *
 *   · **A promise is written after the sale, and only once.** The unit it
 *     covers is a `sale_item`, and the day it starts is the day the shop sold
 *     it, so neither exists before the sale does. Registration is therefore a
 *     separate call the till makes when the sale is in — and it is idempotent
 *     on the server, so a retry, a double click and a Realtime redelivery all
 *     write the same promises.
 *
 *   · **Nothing silently goes unrecorded.** With the plugin on, a completing
 *     sale writes its cover without anybody opening a card; every failure path
 *     — a till that was offline, a plugin switched on after the fact — lands on
 *     one list of sales that still owe a promise, and that list is the second
 *     thing on the plugin's screen.
 *
 *   · **The plugin writes no core table (spec §51).** A claim is not a sale and
 *     a replacement is not a stock movement: when the shop hands a replacement
 *     over it rings it up like anything else, and the ledger stays the core's.
 *
 * This file imports nothing from `src/features/` and nothing from another
 * plugin. If adding it ever requires editing a feature, the architecture has
 * failed (spec §51).
 */

import { badge, stat } from '../../components/ui/card'
import { toastSuccess } from '../../components/feedback/toast'
import { h, srOnly } from '../../components/ui/h'
import type {
  PanelContext,
  PanelLine,
  Plugin,
  PluginAPI,
  PluginPageModule,
  PluginReportResult,
} from '../../shared/registry/plugin-types'
import { coverCard } from './cover-card'
import {
  coverageLabel,
  coverageOf,
  coveredLines,
  daysLeftLabel,
  missingCoverLabel,
  monthsLabel,
  monthsFromProduct,
  unitLabel,
  tillSummary,
  type ClaimsReport,
  type ExpiringReport,
  type Overview,
  type RegisterResult,
  type UnitPage,
} from './helpers'
import {
  AUTO_REGISTER_KEY,
  CLAIM_PREFIX_KEY,
  COVER_ALL_KEY,
  DEFAULT_AUTO_REGISTER,
  DEFAULT_CLAIM_PREFIX,
  DEFAULT_COVER_ALL,
  DEFAULT_MONTHS,
  DEFAULT_MONTHS_KEY,
  DEFAULT_WARN_DAYS,
  LAST_SALE_KEY,
  WARN_DAYS_KEY,
  WARRANTY_MANAGE,
  WARRANTY_MONTHS_KEY,
  WARRANTY_VIEW,
  warrantyManifest,
} from './manifest'

const MS_PER_DAY = 86_400_000

export const warrantyPlugin: Plugin = {
  id: warrantyManifest.id,
  name: warrantyManifest.name,
  version: warrantyManifest.version,
  description: warrantyManifest.description,
  ...(warrantyManifest.icon ? { icon: warrantyManifest.icon } : {}),

  register(api) {
    // ── The cashier's "not this one" ────────────────────────────────────
    // Which covered lines the shop chose *not* to promise on the cart in front
    // of the till, by variant. Kept in the plugin's own closure — the panel is
    // redrawn on every cart change (docs/05), so the DOM cannot hold it — and
    // cleared when the sale it belongs to completes.
    const excluded = new Set<string>()
    // The same choice, snapshotted for the one thing that reads it after the
    // cart is gone: the receipt of the sale that just completed. The register
    // takes its copy over the wire; this is what keeps the slip from printing a
    // promise that was never written.
    let printedExcluded: ReadonlySet<string> = new Set<string>()

    for (const permission of warrantyManifest.permissions ?? []) {
      api.registerPermission({
        key: permission.key,
        label: permission.label,
        group: permission.group,
        ...(permission.description ? { description: permission.description } : {}),
      })
    }

    // ── The product field ───────────────────────────────────────────────
    // `storage: 'metadata'` means the core persists it into `products.metadata`
    // with no plugin-owned column and no extra code — and the shop taxonomy
    // promotes exactly this key for electronics, computer, mobile and appliance
    // shops, so for those shops it sits in the first group of the form rather
    // than behind “Advanced”.
    api.registerProductField({
      key: WARRANTY_MONTHS_KEY,
      label: 'Warranty',
      type: 'number',
      section: 'advanced',
      storage: 'metadata',
      min: 0,
      max: 600,
      step: 1,
      placeholder: '12',
      // The counter is asked “how long is the guarantee?” while the customer is
      // standing there, so it travels to the till — and it prints, because the
      // slip is where a customer looks for it a year later.
      showInPOS: true,
      printable: true,
      importable: true,
      validate: (value: unknown) => {
        if (value === null || value === undefined || value === '') return null
        const months = Number(value)
        if (!Number.isFinite(months)) return 'Enter a number of months.'
        if (months < 0) return 'Warranty months cannot be negative.'
        if (months > 600) return 'Five hundred months is the longest promise this shop can make.'
        return null
      },
      format: (value: unknown) => monthsLabel(monthsFromProduct({ [WARRANTY_MONTHS_KEY]: value })),
    })

    // ── Navigation, and the screen behind it ────────────────────────────
    api.registerNav({
      id: 'warranty',
      label: 'Warranty',
      icon: 'verified_user',
      section: 'inventory',
      route: '/plugins/warranty',
      permission: WARRANTY_VIEW,
      order: 40,
      badge: () => pendingBadge(api),
    })

    api.registerRoute({
      path: '/plugins/warranty',
      title: 'Warranty',
      permission: WARRANTY_VIEW,
      load: async (): Promise<PluginPageModule> => {
        const screen = await import('./warranty-screen')
        return screen.create({ db: api.db, settings: api.settings })
      },
    })

    // ── The dashboard tile ──────────────────────────────────────────────
    api.registerDashboardWidget({
      id: 'warranty.summary',
      title: 'Warranty',
      size: 'sm',
      permission: WARRANTY_VIEW,
      render: () => summaryTile(api),
    })

    // ── The till ────────────────────────────────────────────────────────
    // What the cart is about to promise, before anybody takes the money. The
    // panel cannot write the promise — the sale does not exist yet — so it
    // answers the question the cashier is actually asked at the counter.
    api.registerPOSPanel({
      id: 'warranty.till',
      label: 'Cover',
      permission: WARRANTY_VIEW,
      render: (context) => tillPanel(api, context, excluded),
      // A line the cashier un-ticked was never promised, so its warranty months
      // must not appear on the slip. The host asks this when it builds the
      // receipt for the sale that just completed; `printedExcluded` is that
      // sale's un-ticked lines, and the field it hides is the one this plugin
      // prints (`warranty_months`).
      suppressPrintFields: () => {
        const map = new Map<string, readonly string[]>()
        for (const variantId of printedExcluded) map.set(variantId, [WARRANTY_MONTHS_KEY])
        return map
      },
    })

    // ── The finished sale ───────────────────────────────────────────────
    api.registerSaleTab({
      id: 'warranty.sale',
      label: 'Warranty',
      permission: WARRANTY_VIEW,
      render: (context) => {
        if (!context.saleId) {
          return h('p', { class: 'text-sm text-content-muted' }, 'This sale is not stored yet.')
        }
        return coverCard(
          { db: api.db, settings: api.settings, currency: context.currency },
          context.saleId
        )
      },
    })

    // ── The product form ────────────────────────────────────────────────
    api.registerFormSection({
      id: 'warranty.product',
      label: 'Warranty history',
      section: 'advanced',
      permission: WARRANTY_VIEW,
      render: (context) => productSection(api, context.productId),
    })

    // ── Writing the promise when a sale completes ───────────────────────
    // The same event arrives twice — the till's own echo and the Realtime row —
    // so a sale is written once and is identified by its own id
    // (shared/bus/events.ts). A sale taken while the shop was offline cannot be
    // written here, because the plugin cannot reach the server; nothing is
    // forgotten either: the sale appears on the work queue with its units
    // missing, which is what that list is for.
    const written = new Set<string>()

    api.events.on('sale.completed', (event) => {
      if (!api.settings.get<boolean>(AUTO_REGISTER_KEY, DEFAULT_AUTO_REGISTER)) return
      const saleId = event.data.sale_id
      if (!saleId || written.has(saleId)) return
      written.add(saleId)

      // Take this sale's un-ticked lines before the cart is cleared: the wire
      // call skips them (and any other device honours that, because the server
      // writes them to the sale), and the receipt drawn a moment from now hides
      // their cover. Then the working set is empty for the next customer.
      const skip = [...excluded]
      printedExcluded = new Set(skip)
      excluded.clear()

      void api.db
        .rpc<RegisterResult>('register', {
          sale_id: saleId,
          ...(skip.length > 0 ? { skip_variants: skip } : {}),
        })
        .then((result) => {
          if (result.created === 0) return
          api.storage.set(LAST_SALE_KEY, saleId)
          api.storage.set('pending_units', 0)
          toastSuccess(
            `${result.created} promise${result.created === 1 ? '' : 's'} recorded on ${
              result.invoice_no ?? 'the sale'
            }.`
          )
        })
        .catch((error: unknown) => {
          // A promise that could not be written is not lost: the sale stays on
          // the work queue until somebody writes it.
          api.log.debug(
            'cover not written from the till',
            error instanceof Error ? error.message : error
          )
        })
    })

    // ── Two reports in the core reports screen ──────────────────────────
    // The screen is for working; these are for reading, exporting and printing.
    // Both read the same projection the register does, so an exported file
    // cannot disagree with the screen it came from.
    api.registerReport({
      // Named for the report docs/08 §5 promises the industries that ship this
      // plugin: "Warranty Expiry". The description says it in a shopkeeper's
      // words, which is what the screen under it shows.
      id: 'expiring',
      label: 'Warranty expiry',
      icon: 'hourglass_bottom',
      group: 'Service',
      permission: WARRANTY_VIEW,
      description:
        'Promises that end inside the period you pick — soonest first, including the ones that have already ended.',
      filters: { window: true, search: false },
      run: (context) =>
        expiringReport(api, context, api.settings.get<number>(WARN_DAYS_KEY, DEFAULT_WARN_DAYS)),
    })

    api.registerReport({
      id: 'claims',
      label: 'Warranty claims',
      icon: 'build',
      group: 'Service',
      permission: WARRANTY_VIEW,
      description: 'Every claim in the period, what it was about, where it stands and what it cost.',
      filters: { window: true, search: false },
      run: (context) => claimsReport(api, context),
    })

    api.log.debug('registered', {
      field: WARRANTY_MONTHS_KEY,
      permission: WARRANTY_MANAGE,
      coverAll: api.settings.get<boolean>(COVER_ALL_KEY, DEFAULT_COVER_ALL),
      prefix: api.settings.get<string>(CLAIM_PREFIX_KEY, DEFAULT_CLAIM_PREFIX),
    })
  },
}

// ── The sidebar badge ─────────────────────────────────────────────────────

/**
 * The number a shopkeeper should act on, on the sidebar itself.
 *
 * `pending` is a round trip per sidebar render, and the sidebar renders on
 * navigation — too often for a queue that only changes when a sale is
 * registered. So the badge is answered from the plugin's own data key, which
 * the screen and the tile refresh, and falls back to nothing at all.
 */
function pendingBadge(api: PluginAPI): number | null {
  const cached = api.storage.get<number>('pending_units', 0)
  return cached > 0 ? cached : null
}

// ── The dashboard tile ────────────────────────────────────────────────────

async function summaryTile(api: PluginAPI): Promise<HTMLElement> {
  let overview: Overview
  try {
    overview = await api.db.rpc<Overview>('overview')
    api.storage.set('pending_units', overview.pending.units)
  } catch {
    // A tile must never be the reason the dashboard fails to draw.
    return h('p', { class: 'text-xs text-content-muted' }, 'Warranty cover could not be read.')
  }

  const owed = overview.pending.units
  const expiring = overview.totals.expiring
  const recent = overview.recent[0]

  return h(
    'div',
    { class: 'flex flex-col gap-2' },
    srOnly(
      `Warranty: ${overview.totals.active} promises in force, ${expiring} running out, ${owed} units without a promise`
    ),
    stat('Cover in force', String(overview.totals.active), {
      iconName: 'verified_user',
      tone: expiring > 0 ? 'warning' : 'neutral',
      hint: expiring > 0 ? `${expiring} running out` : 'nothing running out',
    }),
    recent
      ? h(
          'p',
          { class: 'truncate text-xs text-content-muted' },
          `Last: ${recent.product_name} — ${daysLeftLabel(recent.days_left)}`
        )
      : h('p', { class: 'text-xs text-content-muted' }, 'No promise written yet.'),
    owed > 0
      ? h(
          'p',
          { class: 'text-xs text-warning' },
          `${missingCoverLabel(owed)} on ${overview.pending.sales} sale(s).`
        )
      : overview.totals.claims_open > 0
        ? h(
            'p',
            { class: 'text-xs text-content-muted' },
            `${overview.totals.claims_open} claim(s) open.`
          )
        : null
  )
}

// ── The till panel ────────────────────────────────────────────────────────

function tillPanel(api: PluginAPI, context: PanelContext, excluded: Set<string>): HTMLElement {
  const rule = {
    coverAll: api.settings.get<boolean>(COVER_ALL_KEY, DEFAULT_COVER_ALL),
    defaultMonths: api.settings.get<number>(DEFAULT_MONTHS_KEY, DEFAULT_MONTHS),
  }
  const covered = coveredLines(context.lines, rule)

  if (covered.length === 0) {
    return h(
      'p',
      { class: 'text-xs text-content-muted' },
      context.lines && context.lines.length > 0
        ? 'Nothing in this cart carries warranty cover.'
        : 'Add something to the cart to see what it promises.'
    )
  }

  const badgeHost = h('div')
  const drawBadge = (): void => {
    const applied = covered.filter((entry) => !excluded.has(entry.line.variantId))
    const summary = tillSummary(
      applied.map((entry) => entry.line),
      rule
    )
    badgeHost.replaceChildren(
      applied.length === 0
        ? badge('No cover on this sale', { tone: 'neutral', iconName: 'shield' })
        : badge(summary.label, { tone: 'info', iconName: 'verified_user' })
    )
  }
  drawBadge()

  return h(
    'div',
    { class: 'space-y-2' },
    badgeHost,
    h(
      'div',
      { class: 'space-y-1' },
      ...covered.map((entry) => coverRow(entry, excluded, drawBadge))
    ),
    h(
      'p',
      { class: 'text-[11px] text-content-subtle' },
      'Leave a line ticked to promise its cover; untick it to sell it without one. ' +
        'Written on the invoice when the sale completes, and units are named afterwards, on the sale.'
    )
  )
}

/**
 * One covered line, as a tick the cashier can turn off.
 *
 * Ticked is the default and the common case — a shop that switched Warranty on
 * means to keep its promises — so the box starts checked, and un-ticking it is
 * the deliberate "not this one". The choice lives in the shared `excluded` set,
 * not the DOM, so it survives the panel being redrawn when the cart changes.
 */
function coverRow(
  entry: { line: PanelLine; months: number },
  excluded: Set<string>,
  onChange: () => void
): HTMLElement {
  const variantId = entry.line.variantId
  const name = entry.line.variantName
    ? `${entry.line.name} — ${entry.line.variantName}`
    : entry.line.name

  const box = h('input', {
    type: 'checkbox',
    class: 'h-3.5 w-3.5 shrink-0 accent-primary',
    checked: !excluded.has(variantId),
  })
  const nameEl = h('span', { class: 'truncate text-content' }, name)
  const monthsEl = h('span', { class: 'shrink-0 text-content-muted' }, monthsLabel(entry.months))

  const paint = (): void => {
    const on = box.checked
    nameEl.className = on ? 'truncate text-content' : 'truncate text-content-muted line-through'
    monthsEl.className = on
      ? 'shrink-0 text-content-muted'
      : 'shrink-0 text-content-subtle line-through'
  }

  box.addEventListener('change', () => {
    if (box.checked) excluded.delete(variantId)
    else excluded.add(variantId)
    paint()
    onChange()
  })
  paint()

  return h(
    'label',
    {
      class: 'flex cursor-pointer items-center gap-2 text-xs',
      title: box.checked ? 'Covered — untick to leave this line without warranty' : 'No warranty on this line',
    },
    box,
    nameEl,
    h('span', { class: 'flex-1' }),
    monthsEl
  )
}

// ── The product form section ──────────────────────────────────────────────

async function productSection(api: PluginAPI, productId: string | undefined): Promise<HTMLElement> {
  if (!productId) {
    return h(
      'p',
      { class: 'text-xs text-content-muted' },
      'Set the warranty months above, and the promise is written for every unit of this product the shop sells.'
    )
  }

  try {
    // Asked of the server with the product's id: the shop's own newest
    // promises are not this product's history, and counting them in the
    // browser would undercount every product a shop sells a lot of.
    const page = await api.db.rpc<UnitPage>('list', {
      status: 'all',
      search: '',
      product_id: productId,
      limit: 5,
      offset: 0,
    })

    if (page.total === 0) {
      return h(
        'p',
        { class: 'text-xs text-content-muted' },
        'No promise has been written for this product yet — they are written when it is sold.'
      )
    }

    const warnDays = api.settings.get<number>(WARN_DAYS_KEY, DEFAULT_WARN_DAYS)
    const latest = page.rows[0]
    return h(
      'div',
      { class: 'space-y-1' },
      badge(`${page.total} ${page.total === 1 ? 'promise' : 'promises'} on record`, {
        tone: 'info',
        iconName: 'verified_user',
      }),
      latest
        ? h(
            'p',
            { class: 'text-xs text-content-muted' },
            `Latest: ${unitLabel(latest)} · ${coverageLabel(coverageOf(latest, warnDays))} · ${daysLeftLabel(latest.days_left)}`
          )
        : null
    )
  } catch {
    return h('p', { class: 'text-xs text-content-subtle' }, 'Warranty history could not be read.')
  }
}

// ── The reports ───────────────────────────────────────────────────────────

/**
 * The period the shopkeeper picked, as a horizon in days.
 *
 * A window control on a report about *ending cover* cannot mean “trade in
 * August”: the question is always how far ahead to look, so the same six
 * buttons answer that instead. The claims report reads the window the other way
 * round — the period claims were opened in — which is why it takes the dates.
 */
export function horizonDays(
  context: { period: string; from: string | null; to: string | null },
  fallback: number
): number {
  const fixed: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 90, year: 365 }
  if (context.period === 'custom') {
    const from = context.from ? Date.parse(context.from) : NaN
    const to = context.to ? Date.parse(context.to) : NaN
    if (Number.isNaN(from) || Number.isNaN(to)) return fallback
    return Math.max(1, Math.min(730, Math.round((to - from) / MS_PER_DAY) || 1))
  }
  return fixed[context.period] ?? fallback
}

/** The custom dates a report was asked for, when it was asked for any. */
export function windowDates(context: {
  period: string
  from: string | null
  to: string | null
}): { from: string | null; to: string | null } {
  return context.period === 'custom'
    ? { from: context.from, to: context.to }
    : { from: null, to: null }
}

async function expiringReport(
  api: PluginAPI,
  context: { period: string; from: string | null; to: string | null; limit: number; offset: number },
  fallbackDays: number
): Promise<PluginReportResult> {
  const horizon = horizonDays(context, fallbackDays || DEFAULT_WARN_DAYS)
  const payload = await api.db.rpc<ExpiringReport>('report', {
    type: 'expiring',
    days: horizon,
    include_expired: true,
    limit: Math.max(1, Math.min(context.limit, 2000)),
    offset: context.offset,
  })

  const endedHere = payload.rows.filter((row) => row.days_left < 0).length

  return {
    columns: [
      { key: 'product', label: 'Product', type: 'text' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'customer', label: 'Customer', type: 'text' },
      { key: 'invoice', label: 'Invoice', type: 'text' },
      { key: 'ends', label: 'Covered until', type: 'date' },
      { key: 'days', label: 'Days left', type: 'int', align: 'right' },
      { key: 'state', label: 'State', type: 'text' },
      { key: 'claims', label: 'Claims', type: 'int', align: 'right' },
    ],
    rows: payload.rows.map((row) => ({
      product: row.variant_name ? `${row.product_name} — ${row.variant_name}` : row.product_name,
      unit: row.unit_label ?? `Unit ${row.unit_index}`,
      customer: row.customer ?? 'walk-in',
      invoice: row.invoice_no ?? '—',
      ends: row.ends_on,
      days: row.days_left,
      state: coverageLabel(coverageOf(row, horizon)),
      claims: row.claims_count,
    })),
    totalRows: payload.total,
    note:
      `${payload.total} promise(s) ending by ${payload.ends_to}` +
      (endedHere > 0 ? ` · ${endedHere} on this page have already ended` : '') +
      (payload.totals.expired > 0 ? ` · ${payload.totals.expired} ended in all` : ''),
  }
}

async function claimsReport(
  api: PluginAPI,
  context: { period: string; from: string | null; to: string | null; limit: number; offset: number }
): Promise<PluginReportResult> {
  const window = windowDates(context)
  const payload = await api.db.rpc<ClaimsReport>('report', {
    type: 'claims',
    days: horizonDays(context, 90),
    ...(window.from ? { from: window.from } : {}),
    ...(window.to ? { to: window.to } : {}),
    limit: Math.max(1, Math.min(context.limit, 2000)),
    offset: context.offset,
  })

  return {
    columns: [
      { key: 'claim_no', label: 'Slip', type: 'text' },
      { key: 'opened', label: 'Reported', type: 'date' },
      { key: 'closed', label: 'Finished', type: 'date' },
      { key: 'product', label: 'Product', type: 'text' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'customer', label: 'Customer', type: 'text' },
      { key: 'state', label: 'What was reported', type: 'text' },
      { key: 'days', label: 'Days open', type: 'int', align: 'right' },
      { key: 'cost', label: 'Cost', type: 'money', align: 'right' },
    ],
    rows: payload.rows.map((row) => ({
      claim_no: row.claim_no,
      opened: row.opened_on,
      closed: row.closed_on,
      product: row.product_name,
      unit: row.unit_label ?? `Unit ${row.unit_index}`,
      customer: row.customer ?? 'walk-in',
      state: row.issue ?? '—',
      days: row.days_open,
      cost: row.cost_minor,
    })),
    // The cost column totals the *whole period*, not the page: "what did
    // warranty cost me in August" is the question, and an export of page 1 is
    // not an answer to it. The small print below says how many rows that covers.
    totals: { cost: payload.totals.cost_minor },
    totalRows: payload.total,
    note:
      `${payload.total} claim(s) reported between ${payload.from} and ${payload.to}` +
      ` · ${payload.totals.open} still open · the cost column totals the whole period`,
  }
}

export default warrantyPlugin
