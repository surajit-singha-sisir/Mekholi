/**
 * Plugin slots inside core screens (spec §31, §51; docs/05 §7).
 *
 * A plugin describes *what it wants to add* — a dashboard widget, a POS panel,
 * a tab on a sale, a section in the product form — and the core draws it. That
 * is the whole reason adding a plugin never requires editing a feature: the
 * feature asks this module for its slots and renders whatever is registered.
 *
 * Three rules hold for every host in this file, because they are what make a
 * third-party plugin safe to switch on:
 *
 *  1. **Permission first.** A slot whose `permission` the signed-in user lacks
 *     is not rendered at all — the plugin never sees data it should not.
 *  2. **Nothing breaks the screen.** A plugin whose render throws is replaced
 *     by one line naming the plugin; the cart, the sale and the form still
 *     work. The shop loses a decoration, not a shift.
 *  3. **The shop can tell who added it.** Every slot carries a small
 *     attribution badge, so a shopkeeper never has to guess whether a panel is
 *     the core app or an add-on.
 *
 * Slots re-read the registry on `plugin.changed`, so switching a plugin on in
 * Settings makes its widget appear without a reload — and the subscription
 * unsubscribes itself when the screen it belongs to is gone.
 */

import { h, icon, mount } from '../components/ui/h'
import { badge } from '../components/ui/card'
import { button } from '../components/ui/button'
import { eventBus } from '../shared/bus'
import { milliToNumber, minorToNumber } from '../shared/domain/money'
import { pluginRegistry } from './plugins'
import { can } from './state/session'
import type { CartLine } from '../shared/domain/cart'
import type { ReportResult, ReportRow } from '../shared/repositories/contracts'
import type { PluginRegistry } from '../shared/registry/plugin-registry'
import type {
  FormSectionDefinition,
  SaleAdjustmentContext,
  SaleAdjustmentDefinition,
  SaleAdjustmentQuote,
  SaleAdjustmentRelease,
  ScanContext,
  ScanMatch,
  ReportDefinition,
  ReportRunContext,
  DashboardWidgetDefinition,
  HeaderWidgetDefinition,
  PanelContext,
  PanelDefinition,
  PanelLine,
  ProductField,
  TabDefinition,
} from '../shared/registry/plugin-types'

/** Who contributed a slot — shown on every one of them. */
function attribution(source: string | undefined): HTMLElement | null {
  if (!source) return null
  const name = pluginRegistry.get(source)?.manifest.name ?? source
  return badge(name, { tone: 'neutral', iconName: 'extension', class: 'plugin-attribution' })
}

function failed(source: string | undefined, label: string, error: unknown): HTMLElement {
  const name = pluginRegistry.get(source ?? '')?.manifest.name ?? source ?? 'A plugin'
  const message = error instanceof Error ? error.message : String(error)
  // Logged as well as shown: a shopkeeper sees a tidier sentence than a stack.
  console.error(`[plugin-host] "${source ?? '?'}" could not draw ${label}`, error)
  return h(
    'p',
    { class: 'text-xs text-danger' },
    `${name} could not draw ${label}: ${message}`
  )
}

/**
 * Re-render this host when the set of loaded plugins changes.
 *
 * Deliberately self-cleaning: the listener unsubscribes the first time it fires
 * after the host has been detached, so no router changes were needed to avoid
 * leaking a subscription per screen visit.
 */
export function watchPluginSlots(host: HTMLElement, redraw: () => void): void {
  const unsubscribe = eventBus.on('plugin.changed', () => {
    if (!host.isConnected) {
      unsubscribe()
      return
    }
    redraw()
  })
}

/** Slots the signed-in user is allowed to see (docs/07 §4). */
function visible<T extends { permission?: string }>(items: readonly T[]): T[] {
  return items.filter((item) => can(item.permission))
}

/**
 * `ProductField` has no `permission`: a field's edit rights are the plugin's
 * `*.adjust`-style permission, enforced where the value is written, not where
 * the tile is drawn. So fields are filtered by the ones that asked to be shown.
 */
function printableFields(registry: PluginRegistry): ProductField[] {
  return registry.productFields.items.filter((field) => field.printable === true)
}

function posFields(registry: PluginRegistry): ProductField[] {
  return registry.productFields.items.filter((field) => field.showInPOS === true)
}

// ── Dashboard widgets ─────────────────────────────────────────────────────

/**
 * The plugin widgets, as one grid section.
 *
 * Rendered below the core widgets rather than mixed into them: a shopkeeper
 * scanning the top row is reading the shop's own numbers, and those must never
 * depend on a plugin being present.
 */
export function pluginWidgetsHost(registry: PluginRegistry): HTMLElement {
  const host = h('div', { class: 'space-y-2' })

  async function draw(): Promise<void> {
    const widgets = visible<DashboardWidgetDefinition>(registry.widgets.items)
    if (widgets.length === 0) {
      mount(host, null)
      return
    }

    mount(host, h('p', { class: 'text-xs font-semibold uppercase tracking-wide text-content-subtle', text: 'From your plugins' }))

    const tilePromises = widgets.map(async (widget) => {
      try {
        const body = await widget.render()
        return h(
          'div',
          {
            class:
              'rounded-lg border border-border bg-surface p-4 ' +
              (widget.size === 'wide' ? 'sm:col-span-2' : ''),
          },
          h(
            'div',
            { class: 'mb-2 flex items-start justify-between gap-2' },
            h('p', { class: 'text-xs font-medium text-content-muted', text: widget.title }),
            attribution(widget.source)
          ),
          body
        )
      } catch (error) {
        return h(
          'div',
          { class: 'rounded-lg border border-border bg-surface p-4' },
          failed(widget.source, `the “${widget.title}” widget`, error)
        )
      }
    })

    const tiles = await Promise.all(tilePromises)
    mount(host, h('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' }, ...tiles))
  }

  void draw()
  watchPluginSlots(host, () => void draw())
  return host
}

// ── Header widgets ────────────────────────────────────────────────────────

/**
 * The top-bar slot: compact plugin controls between the page title and the
 * shop's own buttons. Same three guarantees as every host — permission
 * first, a throwing widget loses its pixels not the bar, and `title`
 * carries the attribution a badge would be too wide for up here.
 */
export function pluginHeaderHost(registry: PluginRegistry): HTMLElement {
  const host = h('div', { class: 'flex items-center gap-1' })

  async function draw(): Promise<void> {
    const widgets = visible<HeaderWidgetDefinition>(registry.headerWidgets.items).sort(
      (a, b) => (a.order ?? 50) - (b.order ?? 50)
    )
    if (widgets.length === 0) {
      mount(host, null)
      return
    }

    const rendered = await Promise.all(
      widgets.map(async (widget) => {
        try {
          const body = await widget.render()
          const name = pluginRegistry.get(widget.source ?? '')?.manifest.name ?? widget.source ?? ''
          const wrap = h('div', { class: 'flex items-center' }, body)
          if (name) wrap.title = name
          wrap.dataset.pluginSource = widget.source ?? ''
          return wrap
        } catch (error) {
          // The bar is too small for an apology — log it and draw nothing.
          console.error(`[plugin-host] "${widget.source ?? '?'}" could not draw its header widget`, error)
          return null
        }
      })
    )
    mount(host, ...rendered.filter((el) => el !== null))
  }

  void draw()
  watchPluginSlots(host, () => void draw())
  return host
}

// ── The cart, as a plugin may see it ──────────────────────────────────────

/**
 * Projects the cart into the SDK's `PanelLine` vocabulary (docs/11 §5).
 *
 * The catalogue callback is how a line picks up `products.metadata`: a cart
 * line carries the variant and the price, and the product's own fields — a
 * batch number, "this unit needs a serial" — live on the catalogue row the
 * till already read. A variant the till has not seen falls back to no
 * metadata, which a plugin must treat as "not tracked" rather than "no".
 */
export function panelLines(
  lines: readonly CartLine[],
  catalogue: (variantId: string) => { metadata: Record<string, unknown> } | undefined
): PanelLine[] {
  return lines.map((line) => ({
    variantId: line.variantId,
    productId: line.productId,
    name: line.name,
    variantName: line.variantName ?? null,
    sku: line.sku ?? null,
    quantity: milliToNumber(line.quantity),
    unitPrice: minorToNumber(line.unitPrice),
    metadata: catalogue(line.variantId)?.metadata ?? {},
  }))
}

// ── POS panels ────────────────────────────────────────────────────────────

/**
 * Panels beside the cart.
 *
 * `context.total` is the live cart total, and the POS re-renders these on every
 * cart change (see `pos-view`), which is what lets a loyalty panel offer the
 * award *for this sale* rather than for the last one.
 */
export function pluginPanelsHost(registry: PluginRegistry, context: PanelContext): HTMLElement {
  const host = h('div', { class: 'space-y-2' })

  async function draw(): Promise<void> {
    const panels = visible<PanelDefinition>(registry.posPanels.items)
    if (panels.length === 0) {
      mount(host, null)
      return
    }

    const rendered = await Promise.all(
      panels.map(async (panel) => {
        try {
          const body = await panel.render(context)
          // A panel that returns null has nothing to say about this sale — draw
          // no card at all rather than an empty titled box (e.g. warranty with
          // no covered line in the cart).
          if (body === null) return null
          return h(
            'div',
            { class: 'rounded-lg border border-border bg-surface-muted p-3' },
            h(
              'div',
              { class: 'mb-1.5 flex items-center justify-between gap-2' },
              h('p', { class: 'text-xs font-semibold text-content', text: panel.label }),
              attribution(panel.source)
            ),
            body
          )
        } catch (error) {
          return h('div', { class: 'rounded-lg border border-border bg-surface-muted p-3' }, failed(panel.source, 'its panel', error))
        }
      })
    )

    mount(host, ...rendered.filter((card): card is HTMLDivElement => card !== null))
  }

  void draw()
  watchPluginSlots(host, () => void draw())
  return host
}

// ── Sale adjustments: money off, contributed by a plugin ──────────────────

/** An adjustment the cashier has put on the sale in front of them. */
export interface AppliedAdjustment {
  id: string
  source: string
  /** The plugin's own quote, frozen when it was applied. */
  quote: SaleAdjustmentQuote
}

export interface SaleAdjustmentsHostOptions {
  /** What is on the sale right now, owned by the till. */
  applied: readonly AppliedAdjustment[]
  onApply: (adjustment: SaleAdjustmentDefinition, quote: SaleAdjustmentQuote) => void
  onRemove: (
    adjustment: SaleAdjustmentDefinition,
    quote: SaleAdjustmentQuote,
    reason: SaleAdjustmentRelease
  ) => void
}

/**
 * The strip of “money off” a plugin can put on the sale (docs/11 §Sale
 * adjustments).
 *
 * The host does the three things a plugin must not be trusted with: it asks
 * every plugin what it can take off *this* cart, it decides what reaches the
 * sale (the till sums the applied quotes into the one order discount the sale
 * carries), and it re-asks on every cart change so an adjustment the cart has
 * outgrown is withdrawn rather than quietly honoured.
 *
 * A quote that is already applied is never re-priced here — only invalidated.
 * Re-pricing it would spend the customer's balance twice; withdrawing it is a
 * visible act with a reason the plugin is told.
 */
export function saleAdjustmentsHost(
  registry: PluginRegistry,
  context: SaleAdjustmentContext,
  options: SaleAdjustmentsHostOptions
): HTMLElement {
  // A handle for the tests, and for a shop's own CSS: the strip is the only
  // place a plugin's money appears on the till.
  const host = h('div', { class: 'space-y-1', dataset: { adjustmentStrip: '' } })

  async function draw(): Promise<void> {
    const definitions = visible<SaleAdjustmentDefinition>(registry.saleAdjustments.items)
    if (definitions.length === 0) {
      mount(host, null)
      return
    }

    // What the plugins have already taken off, added up. The host is the only
    // party that can see every plugin at once, so the sum is the host's job —
    // and it is the sum that decides whether the till can honour what the
    // plugins have promised.
    const appliedMinor = options.applied.reduce((total, entry) => total + entry.quote.amountMinor, 0)
    const over = appliedMinor > context.totalMinor

    const rows: Array<HTMLElement | null> = []
    for (const definition of definitions) {
      const applied = options.applied.find((entry) => entry.id === definition.id)

      // What this plugin can offer on the cart as it is *now*. Cheap by
      // contract: a plugin that spends money here would spend it twice.
      let quote: SaleAdjustmentQuote | null = null
      try {
        quote = containSaleAdjustmentQuote(await definition.quote(context))
      } catch (error) {
        console.error(`[plugin-host] "${definition.source ?? '?'}" could not quote an adjustment`, error)
        rows.push(failed(definition.source, 'a discount', error))
        continue
      }

      if (applied) {
        // Withdrawn when the plugin no longer offers it at all (the customer
        // was removed, the balance went) or when the adjustments together are
        // worth more than the sale they sit on. That second case is the one
        // that costs a customer real money: `complete_sale` clamps an order
        // discount to the sale, so a plugin that had already debited the points
        // would have taken them for a discount the customer never received.
        if (!quote || over) {
          options.onRemove(definition, applied.quote, 'invalid')
          continue
        }
        rows.push(adjustmentRow(definition, applied.quote, options, true))
        continue
      }

      // A quote the sale cannot pay for is not offered at all — an Apply button
      // that would clamp to nothing is a button that takes points for free.
      if (quote && appliedMinor + quote.amountMinor <= context.totalMinor) {
        rows.push(adjustmentRow(definition, quote, options, false))
      }
    }

    mount(host, ...rows.filter((row): row is HTMLElement => row !== null))
  }

  void draw()
  watchPluginSlots(host, () => void draw())
  return host
}

function adjustmentRow(
  definition: SaleAdjustmentDefinition,
  quote: SaleAdjustmentQuote,
  options: SaleAdjustmentsHostOptions,
  applied: boolean
): HTMLElement {
  return h(
    'div',
    {
      class:
        'flex items-center justify-between gap-2 rounded-lg border border-border ' +
        (applied ? 'bg-surface-muted px-2 py-1.5' : 'bg-surface px-2 py-1.5'),
    },
    h(
      'div',
      { class: 'min-w-0' },
      h('p', { class: 'truncate text-xs font-medium text-content', text: quote.label }),
      quote.note
        ? h('p', { class: 'truncate text-[11px] text-content-muted', text: quote.note })
        : null
    ),
    applied
      ? button('Remove', {
          size: 'sm',
          variant: 'ghost',
          icon: 'undo',
          onClick: () => options.onRemove(definition, quote, 'removed'),
        })
      : button('Apply', {
          size: 'sm',
          variant: 'secondary',
          icon: 'sell',
          onClick: () => options.onApply(definition, quote),
        })
  )
}

/**
 * Containers for a plugin's quote, the same way `containScanMatch` contains a
 * scan: a plugin may describe a discount, and only the host decides what a
 * discount is. Anything that is not a whole number of minor units, or not
 * positive, is not a discount.
 */
export function containSaleAdjustmentQuote(
  quote: SaleAdjustmentQuote | null | undefined
): SaleAdjustmentQuote | null {
  if (!quote) return null
  if (!Number.isInteger(quote.amountMinor) || quote.amountMinor <= 0) return null
  if (typeof quote.label !== 'string' || quote.label.trim() === '') return null

  const clean: SaleAdjustmentQuote = { amountMinor: quote.amountMinor, label: quote.label.trim() }
  if (typeof quote.note === 'string' && quote.note.trim() !== '') clean.note = quote.note.trim()
  if (typeof quote.token === 'string' && quote.token.trim() !== '') clean.token = quote.token.trim()
  return clean
}

// ── Sale tabs ─────────────────────────────────────────────────────────────

/**
 * Tabs on a sale (spec §54's sibling).
 *
 * A tab strip rather than a stack because a sale detail is already long: the
 * customer's balance belongs behind one tap, not at the bottom of a scroll. The
 * strip is hidden entirely when no plugin contributes a tab, so the core sale
 * view looks exactly as it did before any plugin was installed.
 */
export function pluginSaleTabsHost(registry: PluginRegistry, context: PanelContext): HTMLElement {
  const host = h('div', { class: 'space-y-2' })
  let selected: string | null = null

  async function draw(): Promise<void> {
    const tabs = visible<TabDefinition>(registry.saleTabs.items)
    if (tabs.length === 0) {
      mount(host, null)
      return
    }

    const active = tabs.find((tab) => tab.id === selected) ?? tabs[0]
    if (!active) return

    const strip = h(
      'div',
      { class: 'flex flex-wrap gap-1.5', role: 'tablist' },
      ...tabs.map((tab) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': tab.id === active.id ? 'true' : 'false',
            class:
              'inline-flex h-10 items-center gap-1.5 rounded-md border px-3 text-sm font-medium ' +
              (tab.id === active.id
                ? 'border-primary bg-primary/5 text-content'
                : 'border-border bg-surface text-content-muted hover:bg-surface-muted'),
            onClick: () => {
              selected = tab.id
              void draw()
            },
          },
          icon('extension', 'text-base'),
          h('span', { text: tab.label })
        )
      )
    )

    const body = h('div', { class: 'rounded-lg border border-border bg-surface p-3' })
    try {
      mount(body, await active.render(context))
    } catch (error) {
      mount(body, failed(active.source, `the “${active.label}” tab`, error))
    }

    mount(host, strip, body)
  }

  void draw()
  watchPluginSlots(host, () => void draw())
  return host
}

/**
 * The plugin values a receipt should print under each line (spec §32).
 *
 * `printable` fields are read from the product metadata the till already has,
 * so a pharmacy's batch number appears on the slip without the sale being
 * stored with plugin columns — the plugin declares the field, the core prints
 * it, and nothing about the sale's schema changes.
 *
 * Keyed by variant id, because that is what a sale line carries.
 */
export function printableNotes(
  registry: PluginRegistry,
  products: Iterable<{ variantId: string; metadata: Record<string, unknown> }>,
  suppressed?: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, string[]> {
  const fields = printableFields(registry)
  const notes = new Map<string, string[]>()

  if (fields.length === 0) return notes

  for (const product of products) {
    const omit = suppressed?.get(product.variantId)
    const lines: string[] = []
    for (const field of fields) {
      // A line the cashier switched a plugin's cover off for: the promise was
      // never written, so the slip must not claim it was (see PanelDefinition).
      if (omit?.has(field.key)) continue
      const value = product.metadata[field.key]
      if (value === null || value === undefined || value === '') continue
      lines.push(`${field.label}: ${field.format ? field.format(value) : String(value)}`)
    }
    if (lines.length > 0) notes.set(product.variantId, lines)
  }

  return notes
}

/**
 * The printable fields a POS panel wants left off *this* sale's receipt, per
 * variant, merged across every panel that asked.
 *
 * The receipt is built once when a sale completes, and a plugin's panel is the
 * only thing that knows a line's cover was declined at the till — so the host
 * asks each POS panel, right then, which of its own printable fields to omit.
 * Keyed by variant id; the values are the field keys `printableNotes` skips.
 */
export function posPrintSuppressions(registry: PluginRegistry): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>()
  for (const panel of registry.posPanels.items) {
    const asked = panel.suppressPrintFields?.()
    if (!asked) continue
    for (const [variantId, keys] of asked) {
      const set = merged.get(variantId) ?? new Set<string>()
      for (const key of keys) set.add(key)
      merged.set(variantId, set)
    }
  }
  return merged
}

/** The plugin values shown on a POS tile, in the order the plugin declared them. */
export function posFieldValues(
  registry: PluginRegistry,
  metadata: Record<string, unknown>
): Array<{ key: string; label: string; text: string }> {
  const fields = posFields(registry)
  const out: Array<{ key: string; label: string; text: string }> = []
  for (const field of fields) {
    const value = metadata[field.key]
    if (value === null || value === undefined || value === '') continue
    out.push({ key: field.key, label: field.label, text: field.format ? field.format(value) : String(value) })
  }
  return out
}

// ── Product-form sections ─────────────────────────────────────────────────

/**
 * Sections a plugin adds to the product form.
 *
 * `storage: 'table'` plugins own their tables and handle saving themselves;
 * `metadata` plugins get their values carried in `products.metadata` by the
 * core form. This host only draws the section and reports which one it is, so
 * the form can hand back the right values on submit.
 */
export function pluginFormSectionsHost(
  registry: PluginRegistry,
  context: PanelContext,
  section: FormSectionDefinition['section'] = 'basic'
): HTMLElement {
  const host = h('div', { class: 'space-y-3' })

  async function draw(): Promise<void> {
    const sections = visible<FormSectionDefinition>(registry.formSections.items).filter(
      (entry) => (entry.section ?? 'basic') === section
    )
    if (sections.length === 0) {
      mount(host, null)
      return
    }

    const rendered = await Promise.all(
      sections.map(async (entry) => {
        try {
          const body = await entry.render(context)
          return h(
            'div',
            { class: 'border-t border-border pt-3' },
            h(
              'div',
              { class: 'mb-2 flex items-center justify-between gap-2' },
              h('p', { class: 'text-sm font-medium text-content', text: entry.label }),
              attribution(entry.source)
            ),
            body
          )
        } catch (error) {
          return h('div', { class: 'border-t border-border pt-3' }, failed(entry.source, `the “${entry.label}” section`, error))
        }
      })
    )

    mount(host, ...rendered)
  }

  void draw()
  watchPluginSlots(host, () => void draw())
  return host
}

// ── Reports ───────────────────────────────────────────────────────────────

/**
 * The reports a plugin contributes, as the *reports screen* sees them
 * (spec §23, §31).
 *
 * Until this existed, `registerReport` put a definition into a registry nobody
 * read: a plugin could describe a report and no shopkeeper could ever open it.
 * The gap stayed invisible because none of the shipped plugins registered one,
 * and it was found by asking “which acceptance bullet does this serve?” and
 * watching a registered report go nowhere.
 *
 * A plugin report is described, not drawn (see `ReportDefinition`), so the
 * reports screen lists it beside the eleven built-ins, runs it, pages it and
 * exports it through the same code path — and the shopkeeper cannot tell where
 * one ends and the next begins. That parity is the point: a second rendering
 * path would drift from the first within two releases.
 *
 * The key is namespaced (`plugin.<source>.<id>`), so it can never collide with a
 * server catalogue key and a link to a plugin report (`#/reports?report=…`) is
 * a stable URL rather than a position in a list.
 */
export interface PluginReport {
  key: string
  id: string
  source: string
  label: string
  group: string
  description: string
  icon: string
  filters: { window: boolean; search: boolean }
  run: ReportDefinition['run']
}

export const PLUGIN_REPORT_PREFIX = 'plugin.'

export function pluginReportKey(source: string, id: string): string {
  return `${PLUGIN_REPORT_PREFIX}${source}.${id}`
}

export function isPluginReportKey(key: string): boolean {
  return key.startsWith(PLUGIN_REPORT_PREFIX)
}

/**
 * Registered reports the signed-in user may open, in registry order — which is
 * the order plugins were loaded, so a shop sees its reports in a stable order
 * rather than one that changes with the alphabet.
 */
export function pluginReports(registry: PluginRegistry): PluginReport[] {
  return visible<ReportDefinition>(registry.reports.items).map((definition) => {
    const source = definition.source ?? 'plugin'
    const name = registry.get(source)?.manifest.name ?? source
    return {
      key: pluginReportKey(source, definition.id),
      id: definition.id,
      source,
      label: definition.label,
      group: definition.group ?? name,
      description: definition.description ?? '',
      icon: definition.icon,
      filters: {
        window: definition.filters?.window ?? true,
        search: definition.filters?.search ?? false,
      },
      run: definition.run,
    }
  })
}

/**
 * A plugin's rows, dressed as the `ReportResult` the table and the exporters
 * already take.
 *
 * Two jobs, both the host's rather than the plugin's:
 *
 *   **Completion.** The plugin answers with columns, rows and (optionally)
 *   totals; the title, label, currency, timestamp and paging facts are filled
 *   in here, so eleven plugin reports cannot disagree about what “1–25 of 431”
 *   means.
 *
 *   **Containment.** A plugin is somebody else's code. Rows are clipped to the
 *   page the host asked for, cells whose column is not in `columns` are dropped
 *   (a stray key would otherwise reach the CSV), and a cell that is an object
 *   or an array becomes text rather than `[object Object]` in a shopkeeper's
 *   spreadsheet. A plugin that returns nonsense produces a slightly empty
 *   report, not a broken screen.
 */
export async function runPluginReport(
  report: PluginReport,
  context: ReportRunContext,
  options: { currency: string; periodLabel?: string }
): Promise<ReportResult> {
  const result = await report.run(context)
  const columns = (Array.isArray(result?.columns) ? result.columns : []).slice()
  const keys = new Set(columns.map((column) => column.key))
  const rows = (Array.isArray(result?.rows) ? result.rows : []).slice(0, context.limit)

  const clean: ReportRow[] = rows.map((row) => {
    const cells: ReportRow = {}
    for (const [key, value] of Object.entries(row ?? {})) {
      if (!keys.has(key)) continue
      cells[key] =
        value === null || typeof value === 'string' || typeof value === 'number'
          ? value
          : String(value)
    }
    return cells
  })

  const totals: Record<string, number> = {}
  for (const [key, value] of Object.entries(result?.totals ?? {})) {
    if (keys.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      totals[key] = value
    }
  }

  return {
    key: report.key,
    title: report.label,
    group: report.group,
    description: report.description,
    columns,
    rows: clean,
    totals,
    // A plugin that returned everything it has does not have to count: the
    // host knows how many rows it was handed — the *unclipped* number, because
    // “1–2 of 3” is the truth when a report has three rows and the page holds
    // two.
    totalRows:
      typeof result?.totalRows === 'number' ? result.totalRows : (result?.rows?.length ?? 0),
    offset: context.offset,
    limit: context.limit,
    // A plugin report is not sorted by the host: sorting is the plugin's to do,
    // because its data may not even be in this browser. Its headers are labels,
    // not buttons, rather than buttons that do nothing.
    sort: '',
    dir: 'desc',
    search: context.search || null,
    period: context.period,
    // The subtitle reads the way a built-in's does — the window, then any small
    // print the plugin added. A report that ignores the window says so by
    // declaring `filters.window: false`, and then nothing here claims a period.
    label: [
      report.filters.window ? options.periodLabel ?? context.period : 'All rows',
      result?.note,
    ]
      .filter(Boolean)
      .join(' · '),
    from: context.from ?? '',
    to: context.to ?? '',
    currency: result?.currency ?? options.currency,
    generatedAt: new Date().toISOString(),
  }
}

// ── Scan resolvers ────────────────────────────────────────────────────────

/** A code a plugin recognised, with the plugin that recognised it. */
export interface ResolvedScan {
  source: string
  /** The plugin's own label, for the sentence a cashier reads. */
  label: string
  match: ScanMatch
}

/**
 * Ask the plugins what a scanned code means — the middle step of the till's
 * three-step resolution (barcode table, plugins, search).
 *
 * The order matters in both directions. A plugin is only asked about a code the
 * shop's **own barcodes did not match**, so a plugin can never shadow a real
 * barcode; and a plugin only ever hands back a *code*, so a plugin can never
 * invent a product the shop does not sell. What a plugin adds is the ability to
 * read a code the core has never seen — a scale label, a prepaid card.
 *
 * The first readable resolver that claims the code wins, in registry order
 * (load order, so a shop's arrangement is stable). A resolver that throws is
 * logged and skipped: the till must not lose a sale because an add-on
 * misbehaved.
 */
export async function resolveScan(
  registry: PluginRegistry,
  code: string,
  context: ScanContext
): Promise<ResolvedScan | null> {
  const trimmed = code.trim()
  if (trimmed === '') return null

  for (const resolver of visible(registry.scanResolvers.items)) {
    let match: ScanMatch | null
    try {
      match = await resolver.resolve(trimmed, context)
    } catch (error) {
      console.error(`[plugin-host] "${resolver.source ?? '?'}" could not read a scan`, error)
      continue
    }
    const clean = containScanMatch(match)
    if (clean) return { source: resolver.source ?? 'plugin', label: resolver.label, match: clean }
  }
  return null
}

/**
 * A match the cart can be trusted with, or null.
 *
 * Same rule as every other slot: the host contains what a third party might get
 * wrong. A lookup code that is not a non-empty string, a quantity that is not a
 * positive finite number and a price that is not a non-negative whole number of
 * minor units are all dropped — a line that cannot be added is better than a
 * line added wrongly.
 */
export function containScanMatch(match: ScanMatch | null | undefined): ScanMatch | null {
  if (!match) return null
  const lookupCode = typeof match.lookupCode === 'string' ? match.lookupCode.trim() : ''
  if (lookupCode === '') return null

  const clean: ScanMatch = { lookupCode }
  if (typeof match.quantity === 'number' && Number.isFinite(match.quantity) && match.quantity > 0) {
    clean.quantity = match.quantity
  }
  if (
    typeof match.unitPriceMinor === 'number' &&
    Number.isInteger(match.unitPriceMinor) &&
    match.unitPriceMinor >= 0
  ) {
    clean.unitPriceMinor = match.unitPriceMinor
  }
  if (typeof match.note === 'string' && match.note.trim() !== '') clean.note = match.note.trim()
  return clean
}
