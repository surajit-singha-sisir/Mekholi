/**
 * The plugin contract (spec §31, §51).
 *
 * A plugin never imports a feature module and never calls the database
 * directly. It receives a scoped `PluginAPI` and registers *descriptions* of
 * things — a nav item, a product field, an entity. The core renders them.
 *
 * That indirection is the whole point: because the core owns the product form
 * and the cart, a plugin adding an expiry date cannot fork the sales engine.
 */

import type { EventBus } from '../bus/event-bus'
import type { MiddlewareDefinition } from './plugin-middleware'
import type { PluginPricing } from './plugin-licence'
// Type-only, and only the two shapes a report is made of — those types already
// exist because the eleven built-in reports return them.
import type { ReportColumn, ReportRow } from '../repositories/contracts'

// ── Nav ───────────────────────────────────────────────────────────────────

export interface NavItem {
  id: string
  label: string
  /** Material Symbols Rounded ligature name. */
  icon: string
  /** Sidebar section; unknown ids fall back to a section created on the fly. */
  section?: string
  route: string
  /** Permission key gating visibility. Omit for always-visible items. */
  permission?: string
  /** Lower sorts first within a section. Defaults to 100. */
  order?: number
  /** Live badge count, re-read on each sidebar render. */
  badge?: () => number | string | null
  /** Set by the host. Never author this. */
  source?: string
}

// ── Product fields (spec §14, §51) ────────────────────────────────────────

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'date'
  | 'datetime'
  | 'select'
  | 'boolean'

export interface FieldOption {
  value: string
  label: string
}

export interface ProductField {
  key: string
  label: string
  type: FieldType
  options?: FieldOption[]
  /** Progressive disclosure: `advanced` fields stay collapsed by default. */
  section?: 'basic' | 'advanced'
  required?: boolean
  placeholder?: string
  min?: number
  max?: number
  step?: number
  /**
   * `metadata` → the core persists it into `products.metadata` for free.
   * `table`    → the plugin owns a `plg_<id>_*` table and handles persistence
   *              itself through the API it registers.
   */
  storage: 'metadata' | 'table'
  /**
   * Show this value on the POS product tile — where a cashier deciding what to
   * ring up can act on it. Only meaningful for `storage: 'metadata'`, since
   * that is the value the catalogue carries to the till.
   */
  showInPOS?: boolean
  /**
   * Print this value under the line on the receipt (spec §32) — the batch
   * number a pharmacy needs on the slip, the warranty code a repair shop
   * quotes. The POS passes what it knows at the till; if the product was not
   * scanned in this session the line simply prints without it.
   */
  printable?: boolean
  /**
   * Include this value as a column in product CSV import/export (spec §14).
   *
   * Declared now, read by the CSV screen when it lands: the flag is part of a
   * plugin's contract with the core, and a plugin author should not have to
   * guess whether their field can travel.
   */
  importable?: boolean
  /** Return an error string to block save, or null to accept. */
  validate?: (value: unknown, product: ProductDraft) => string | null
  /** Hide the field unless the product already warrants it. */
  visible?: (product: ProductDraft) => boolean
  format?: (value: unknown) => string
  /** Set by the host. Never author this. */
  source?: string
}

/**
 * The shape the product form hands to field validators. Core columns are
 * typed; plugin-owned values arrive in `metadata`.
 */
export interface ProductDraft {
  id?: string
  name: string
  sku?: string | null
  price: number | null
  cost_price: number | null
  track_stock: boolean
  metadata: Record<string, unknown>
  [extra: string]: unknown
}

// ── Entities, permissions, reports, settings ──────────────────────────────

export interface EntityDefinition {
  id: string
  label: string
  icon: string
  route: string
  permission?: string
  order?: number
  /** Set by the host. Never author this. */
  source?: string
}

export interface PermissionDefinition {
  key: string
  label: string
  group: string
  description?: string
  /** Set by the host. Never author this. */
  source?: string
}

/**
 * A report a plugin contributes to the *core* reports screen (spec §23, §31).
 *
 * A plugin does not draw its report. It returns the rows, and the host draws
 * them with the same table, the same totals chips, the same paging and the same
 * CSV/print/PDF exporters as the eleven built-in reports — so a shopkeeper
 * cannot tell which reports shipped with the app and which one arrived with an
 * add-on, and an export can never disagree with the screen it came from.
 *
 * That is a deliberate choice against `render: () => HTMLElement`: an element
 * would have been three lines shorter for a plugin and would have made the
 * export buttons above it useless, because they read a `ReportResult` rather
 * than a DOM node. A plugin that needs something other than a table owns a
 * screen instead — `registerRoute` is right there.
 */
export interface ReportDefinition {
  id: string
  label: string
  /** Material Symbols Rounded ligature name. */
  icon: string
  permission?: string
  /**
   * Library group, e.g. “Pharmacy”. Defaults to the plugin's own name, so a
   * one-report plugin has no decision to make here.
   */
  group?: string
  /** One line under the title — what the rows are, in the shopkeeper's words. */
  description?: string
  /**
   * Which core filters to show above the table. A windowed report that cannot
   * be searched should not be handed a search box that does nothing.
   * Defaults: `{ window: true, search: false }`.
   */
  filters?: { window?: boolean; search?: boolean }
  /** The rows for the filters the host passed in. */
  run: (context: ReportRunContext) => PluginReportResult | Promise<PluginReportResult>
  /** Set by the host. Never author this. */
  source?: string
}

/** What the host knows when it asks a plugin for a report. */
export interface ReportRunContext {
  /** `day` | `week` | `month` | `quarter` | `year` | `custom`. */
  period: string
  /** ISO dates, only when the shopkeeper picked a custom range. */
  from: string | null
  to: string | null
  /** What the shopkeeper typed in the search box, when the host shows one. */
  search: string
  /** The branch the till is on, when there is one. */
  branchId: string | null
  /** The page being drawn. A plugin may page on the server or return all rows. */
  limit: number
  offset: number
}

/**
 * What a plugin hands back. Deliberately smaller than the `ReportResult` the
 * host renders: the title, the label, the currency, the timestamp and the
 * paging facts are the host's business, because eleven reports must not each
 * decide what “1–25 of 431” means.
 *
 * Money is **minor units** in `rows` and `totals`, like every other report — a
 * float that has already been rounded once prints wrong.
 */
export interface PluginReportResult {
  columns: ReportColumn[]
  rows: ReportRow[]
  totals?: Record<string, number>
  /**
   * How many rows the filters match in total. Omit it when you returned them
   * all and the host will say so itself.
   */
  totalRows?: number
  /** Defaults to the shop's currency. */
  currency?: string
  /** Small print under the table — a window, a caveat, what is still missing. */
  note?: string
}

export interface SettingsSectionDefinition {
  id: string
  label: string
  icon: string
  permission?: string
  render: () => HTMLElement | Promise<HTMLElement>
  /** Set by the host. Never author this. */
  source?: string
}

export interface ShortcutDefinition {
  /** e.g. `F2`, `Ctrl+K`, `Ctrl+Shift+P` */
  combo: string
  action: string
  label: string
  handler: () => void
  /** Set by the host. Never author this. */
  source?: string
}

// ── Services handed to plugins ────────────────────────────────────────────

/**
 * Namespaced key/value storage. Backed by localStorage in Phase 1 and by the
 * RLS-protected `plugin_data` table in Phase 6 — the interface is already
 * plugin-scoped so the swap is invisible to plugin authors.
 */
export interface PluginStorage {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
  delete(key: string): void
  keys(): string[]
}

/**
 * Org-scoped plugin data (docs/05 §4). Asynchronous because it lives in the
 * database, not in the browser: the same plugin must see the same values from
 * an Android client (Phase 8), and per-device localStorage cannot do that.
 *
 * `storage` above stays synchronous and per-device; `data` is the shared one.
 */
export interface PluginDataStore {
  get<T>(key: string, fallback: T): Promise<T>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<boolean>
  keys(): Promise<string[]>
}

export interface Logger {
  debug(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/**
 * What a plugin can reach. Deliberately narrow: no fetch, no Supabase client,
 * no router navigation, no access to other plugins. Anything a plugin needs
 * beyond this must be added here explicitly, which keeps the surface reviewable.
 */
export interface DashboardWidgetDefinition {
  id: string
  title: string
  /** `sm` spans one tile, `wide` two — same scale as the core widgets. */
  size?: 'sm' | 'wide'
  permission?: string
  render: () => HTMLElement | Promise<HTMLElement>
  /** Set by the host. Never author this. */
  source?: string
}

/**
 * A small control a plugin pins into the top bar — a bell, a sync light, a
 * live rate. The top bar is the one strip of screen that is present on
 * every view and sticky through every scroll, which is exactly why it is
 * rationed: a widget here must earn the pixels, and the host draws it
 * compact, at icon scale, between the page title and the shop controls.
 *
 * The element may position its own overlays (a dropdown panel, a strip
 * under the bar) relative to the header — the header is the widget's
 * nearest positioned ancestor by design.
 */
export interface HeaderWidgetDefinition {
  id: string
  permission?: string
  /** Lower draws first (leftmost). Default 50. */
  order?: number
  render: () => HTMLElement | Promise<HTMLElement>
  /** Set by the host. Never author this. */
  source?: string
}

/** Extra UI inside core-owned surfaces (docs/05 §5-§7). */
export interface PanelDefinition {
  id: string
  label: string
  permission?: string
  render: (context: PanelContext) => HTMLElement | Promise<HTMLElement>
  /** Set by the host. Never author this. */
  source?: string
}

export interface TabDefinition {
  id: string
  label: string
  permission?: string
  render: (context: PanelContext) => HTMLElement | Promise<HTMLElement>
  /** Set by the host. Never author this. */
  source?: string
}

/**
 * Money off the till's sale, contributed by a plugin.
 *
 * The till has always known how to *take* a discount — `complete_sale` has
 * priced `p_discount_type`/`p_discount_value` since migration 012, and the cart
 * domain has modelled both a line and an order discount since the beginning —
 * but nothing the shopkeeper could press put one there, so a plugin that had
 * earned the customer a discount (loyalty points, a promotion, a coupon) could
 * describe it and not give it. This is the seam that closes that: a plugin is
 * asked what it can take off *this* cart, and the host puts it on the sale.
 *
 * Two rules make it safe to hand a plugin the money:
 *
 *  · **The quote is a description, not a decision.** The host owns the amount
 *    that reaches the sale: it clamps to the cart, sums every applied
 *    adjustment into the one order discount the sale carries, and prints
 *    `Discount` in the totals where the cashier already looks. A plugin cannot
 *    charge a price, only ask for money off a sale the core has already priced.
 *  · **A quote, once applied, is frozen.** The cashier's cart changes constantly
 *    (a line added, the customer swapped), and a re-quote that silently changed
 *    the amount would be a second debit against the customer's balance. The
 *    host re-quotes only to check the adjustment is still valid; if it is not,
 *    it releases it, and the plugin is told why.
 */
export interface SaleAdjustmentContext {
  organizationId: string
  branchId: string | null
  currency: string
  customerId: string | null
  /**
   * The cart total in **minor units**, the basis any adjustment reduces.
   *
   * Deliberately the total *before* any adjustment — what the customer owes if
   * nothing is taken off. A plugin quoting `min(balance, total)` against a
   * total its own discount had already reduced would quote a smaller and
   * smaller amount the longer the cashier looked at it.
   */
  totalMinor: number
  /** What is on the sale, for an adjustment that depends on what is in it. */
  lines?: readonly PanelLine[]
}

/** What a plugin can take off the sale in front of the cashier. */
export interface SaleAdjustmentQuote {
  /** Minor units. The host clamps this to the cart; it can never go negative. */
  amountMinor: number
  /** The button the cashier presses, e.g. `Redeem 500 points`. */
  label: string
  /** One line under the button, e.g. `500 points · ৳50.00 off`. */
  note?: string
  /**
   * The plugin's own handle for this quote — a redemption id, a coupon code.
   * Opaque to the host, returned verbatim on release and settlement so the
   * plugin can match the money it gave to the sale that took it.
   */
  token?: string
}

/** Why an applied adjustment came off the sale. */
export type SaleAdjustmentRelease = 'removed' | 'invalid' | 'cleared'

/** The sale an applied adjustment ended up in. */
export interface SaleAdjustmentSettlement {
  saleId: string
  invoiceNo: string
  /**
   * False when the till could not reach the server and the sale is waiting in
   * the outbox. The discount is in the shop's hands either way; what is missing
   * is the invoice number to settle against.
   */
  stored: boolean
}

export interface SaleAdjustmentDefinition {
  id: string
  /** The panel heading, e.g. `Loyalty`. */
  label: string
  permission?: string
  /**
   * What this plugin can take off the cart right now, or `null` for “nothing,
   * here”. Called on every cart change, so it must be cheap and must not write:
   * a quote that spends money is a quote that can spend it twice.
   */
  quote: (
    context: SaleAdjustmentContext
  ) => SaleAdjustmentQuote | null | Promise<SaleAdjustmentQuote | null>
  /** Called once, when the cashier applies the quote. This is where money moves. */
  onApplied?: (
    quote: SaleAdjustmentQuote,
    context: SaleAdjustmentContext
  ) => void | Promise<void>
  /** The cashier took it off, or the cart moved out from under it. */
  onReleased?: (
    quote: SaleAdjustmentQuote,
    reason: SaleAdjustmentRelease
  ) => void | Promise<void>
  /** The sale this adjustment was applied to has been taken. */
  onSettled?: (
    quote: SaleAdjustmentQuote,
    settlement: SaleAdjustmentSettlement
  ) => void | Promise<void>
  /** Set by the host. Never author this. */
  source?: string
}

export interface FormSectionDefinition {
  id: string
  label: string
  /** `advanced` sections live behind “+ Advanced options”. */
  section?: 'basic' | 'advanced'
  permission?: string
  render: (context: PanelContext) => HTMLElement | Promise<HTMLElement>
  /** Set by the host. Never author this. */
  source?: string
}

/**
 * A code the till scanned that the shop's own barcodes did not match.
 *
 * The till resolves a scan in three steps, and this is the middle one: the
 * shop's barcode table first (authoritative, and offline-cached), then the
 * plugins, then an ordinary search. A plugin in the middle is how a scale label
 * printed by the shop's own weighing machine — `2212340007504`, which is not a
 * product barcode and never will be — becomes a sale.
 *
 * A resolver **decodes and nothing else**: it answers with a code the core can
 * look up, not with a product. A plugin cannot invent a product the shop does
 * not sell, cannot price something the catalogue does not price, and needs no
 * access to the catalogue to be useful. `Gift Cards` turns a card number into
 * its own code, a weighing scale turns a label into its PLU.
 */
export interface ScanContext {
  organizationId: string
  branchId: string | null
  warehouseId: string
  currency: string
}

/** What a resolver decided a code means. */
export interface ScanMatch {
  /** The code the core should look up — usually a PLU. */
  lookupCode: string
  /** Sale units: `2.35` for a 2.350 kg label. Defaults to one. */
  quantity?: number
  /** Minor units per unit, when the label itself carried the price. */
  unitPriceMinor?: number
  /** One line for the cashier, e.g. `Scale label · 2.350 kg`. */
  note?: string
}

export interface ScanResolverDefinition {
  id: string
  /** Shown to the cashier when the code is recognised but cannot be sold. */
  label: string
  permission?: string
  /**
   * `null` means “not mine”. A resolver is asked on every scan that misses the
   * barcode table, so it must answer quickly and must not guess: a wrong answer
   * rings up the wrong product, which is worse than no answer at all.
   */
  resolve: (code: string, context: ScanContext) => ScanMatch | null | Promise<ScanMatch | null>
  /** Set by the host. Never author this. */
  source?: string
}

/**
 * One line of the till's cart, as a plugin may see it.
 *
 * A plugin that decorates a sale needs to know what is *on* the sale. Without
 * this a serial-number panel can offer a box to scan into and no way to say
 * which line the unit belongs to, and a promotions panel cannot see what the
 * customer is actually buying — both would have to guess from the total.
 *
 * Deliberately a projection and not the cart itself: no line ids, no
 * discounts, no tax breakdown, nothing a plugin could mutate. Quantity and
 * price are plain numbers, because a plugin has no business knowing about
 * milli-units, and `metadata` is the product's own — which is where a plugin's
 * registered product fields live.
 */
export interface PanelLine {
  variantId: string
  productId: string
  name: string
  variantName: string | null
  sku: string | null
  quantity: number
  unitPrice: number
  metadata: Record<string, unknown>
}

/**
 * What a slot's `render` receives. The ids are the ones the host is showing;
 * nothing here can read the database, which is what keeps a plugin's panel a
 * description of the sale rather than a second implementation of it.
 */
export interface PanelContext {
  organizationId: string
  branchId: string | null
  currency: string
  /** Present on sale-scoped slots (sale tab, POS panel with a cart). */
  saleId?: string
  customerId?: string | null
  total?: number
  /**
   * The cart, on the POS panel. Absent on slots that are not the till.
   *
   * A plugin's POS panel is re-drawn whenever the cart changes, so this is
   * always the cart in front of the cashier — and a plugin that keeps state
   * across those redraws keeps it in its own closure, not in the DOM.
   */
  lines?: readonly PanelLine[]
  /** Present on the product form. */
  productId?: string
}

/** A plugin's declarative description — data only, cheap to import. */
export interface PluginManifest {
  /** Stable id. Also the permission namespace and the SQL table prefix. */
  id: string
  name: string
  version: string
  /** Semver range of the core plugin API this plugin requires. */
  coreApiVersion: string
  description: string
  category: 'core' | 'optional' | 'industry'
  icon?: string
  author?: string
  dependencies?: readonly string[]
  conflicts?: readonly string[]
  permissions?: readonly PermissionDefinition[]
  settingsSchema?: readonly SettingField[]
  /** `persistent` means disabling keeps the shop's data (the default). */
  dataOwnership?: 'transient' | 'persistent'
  /**
   * What the shop pays to run this. Absent means free — but every plugin in
   * this bundle states it, because a price that is implied is a price that is
   * argued about later.
   */
  pricing?: PluginPricing
  /**
   * A small illustration for the Plugins screen, as a data URI or a path. The
   * screen draws a generated cover when this is absent, so a plugin is never
   * a grey rectangle.
   */
  cover?: string
}

export interface SettingField {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select'
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: readonly FieldOption[]
  placeholder?: string
  helpText?: string
}

export interface PluginAPI {
  readonly pluginId: string
  readonly events: EventBus
  readonly storage: PluginStorage
  readonly log: Logger

  /** Org-scoped settings, backed by `plugins.config`. */
  readonly settings: PluginSettings
  /** Org-scoped data, backed by `plugin_data` (the RLS-protected table). */
  readonly data: PluginDataStore
  /** Core reads and the plugin's own RPCs. */
  readonly db: PluginDb

  registerNav(item: NavItem): void
  registerProductField(field: ProductField): void
  registerEntity(entity: EntityDefinition): void
  registerPermission(permission: PermissionDefinition): void
  registerReport(report: ReportDefinition): void
  registerSettingsSection(section: SettingsSectionDefinition): void
  registerShortcut(shortcut: ShortcutDefinition): void
  registerDashboardWidget(widget: DashboardWidgetDefinition): void
  registerHeaderWidget(widget: HeaderWidgetDefinition): void
  registerScanResolver(resolver: ScanResolverDefinition): void
  registerSaleAdjustment(adjustment: SaleAdjustmentDefinition): void
  registerPOSPanel(panel: PanelDefinition): void
  registerSaleTab(tab: TabDefinition): void
  registerFormSection(section: FormSectionDefinition): void
  registerRoute(route: RouteDefinition): void
  /**
   * Take part in a core action — the seam that lets a plugin change what the
   * shop *does*, not just what it shows (see `plugin-middleware.ts`).
   */
  registerMiddleware(middleware: MiddlewareDefinition): void
}

/**
 * The narrow data surface a plugin gets (docs/05 §4). Reads go through one
 * projection; writes go through the plugin's own functions by name. A plugin
 * cannot name a core table or a core RPC here — the host would not forward it.
 */
export interface PluginDb {
  products(): Promise<ProductSnapshot[]>
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
}

export interface ProductSnapshot {
  id: string
  name: string
  sku: string | null
  price: number | null
  track_stock: boolean
  is_active: boolean
  reorder_point: number | null
  metadata: Record<string, unknown>
}

/** A screen a plugin contributes. Loaded lazily, like everything else. */
export interface PluginPageContext {
  params: Record<string, string>
  query: URLSearchParams
  organizationId: string
  /**
   * The shop's display name.
   *
   * Handed over because a plugin may not read the session for itself, and a
   * screen that prints or previews anything the customer sees needs the name
   * above it. An id is not something you can put on a receipt.
   */
  organizationName: string
  branchId: string | null
  currency: string
}

export interface PluginPageModule {
  render: (ctx: PluginPageContext) => HTMLElement | Promise<HTMLElement>
}

export interface RouteDefinition {
  path: string
  title: string
  permission?: string
  load: () => Promise<PluginPageModule>
  /** Set by the host. Never author this. */
  source?: string
}

export interface PluginSettings {
  get<T>(key: string, fallback: T): T
  all(): Readonly<Record<string, unknown>>
  set(key: string, value: unknown): Promise<void>
}

/** A plugin as shipped in this bundle: cheap manifest plus a lazy body. */
export interface ShippedPlugin {
  manifest: PluginManifest
  /** Only called when the plugin is enabled — a disabled plugin costs nothing. */
  load: () => Promise<Plugin>
  /**
   * Load this one whatever the shop's catalogue says.
   *
   * For the handful of plugins that are really *core code kept out of the
   * main bundle*: they own no server data, cost nothing, and were shipped as
   * built-in screens before they were split out. Printer Setup is the
   * example — gating a page that configures the shop's own printer behind a
   * `plugin_packages` row means that if the row is missing, or the device is
   * offline, or the catalogue read fails, the shopkeeper loses access to
   * their hardware settings and the menu entry simply is not there.
   *
   * Never set this on anything that charges money or writes to a table of
   * its own. Those must be a deliberate, recorded decision by the shop.
   */
  alwaysOn?: boolean
}

export interface Plugin {
  /** Stable identifier. Also the permission namespace and the storage prefix. */
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  /** Plugin ids that must load first. Cycles are rejected at load time. */
  dependencies?: string[]
  register(api: PluginAPI): void | Promise<void>
  /** Called on logout and on unload. Must release timers and listeners. */
  dispose?(): void
}

export type PluginStatus =
  | 'disabled'
  | 'loaded'
  | 'error'
  | 'incompatible'
  | 'blocked'

export interface PluginRegistration {
  id: string
  manifest: PluginManifest
  status: PluginStatus
  error?: string
  loadedAt?: string
}
