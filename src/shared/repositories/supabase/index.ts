/**
 * The PostgREST + RPC data source (docs/02 §2).
 *
 * The split is the whole design: **reads** go through PostgREST, which is
 * cacheable, composable and works offline against a mirror; **writes** go
 * through Postgres functions, because a sale has to lock the stock rows, check
 * the balance, move the ledger and publish the outbox event as one atomic act.
 * A client that inserted `sales`, `sale_items` and `stock_movements` itself
 * would have to reimplement all four and get the locking wrong.
 *
 * The client is injected rather than imported. `shared/` stays free of the app
 * layer, the repositories become testable against a stub, and swapping in an
 * IndexedDB implementation later touches the composition root only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Brand,
  Category,
  CompletedSale,
  CustomerRow,
  Page,
  PaymentMethod,
  PosCatalogRow,
  ProductRow,
  RegisterRow,
  RegisterSessionRow,
  ResumedSale,
  SaleRow,
  Tax,
  Unit,
  VariantRow,
} from '../../types/records'
import type {
  AuditEntry,
  AuditRepository,
  CatalogRepository,
  CustomerRepository,
  ExpenseRepository,
  ExpenseRow,
  OrganizationRepository,
  OrganizationSettings,
  RoleRow,
  StaffRow,
  PluginCatalogEntry,
  PluginImpactRole,
  PluginStateEntry,
  PluginRepository,
  ProductBarcode,
  ProductRepository,
  ProductSnapshot,
  PurchaseDetail,
  PurchasePaymentRow,
  PurchaseRepository,
  PurchaseRow,
  RefundResult,
  ReturnsRepository,
  RegisterReport,
  RegisterRepository,
  RegisterSessionSummary,
  Repositories,
  SaleDetail,
  SaleRepository,
  SaleReturnRow,
  SalesListRow,
  SellableProduct,
  SalesFloor,
  StockMovementRow,
  AnalyticsCatalog,
  AnalyticsPoint,
  AnalyticsRepository,
  AnalyticsSlice,
  AnalyticsTotals,
  BiAnswer,
  DashboardSummary,
  AnalyticsQuery,
  ReportColumn,
  ReportColumnType,
  ReportQuery,
  ReportRepository,
  ReportResult,
  ReportRow,
  ReportSummary,
  StockOperationResult,
  StockRepository,
  StockRow,
  StockSummary,
  SupplierRepository,
  SupplierRow,
  WarehouseOption,
} from '../contracts'
import {
  milli,
  milliToNumber,
  minor,
  minorToNumber,
  type Milli,
  type Minor,
} from '../../domain/money'
import type { SaleItemPayload, SalePaymentPayload } from '../../domain/cart'

// ── Conversion ────────────────────────────────────────────────────────────
// Postgres `numeric` crosses PostgREST as a string. Converting here, once, is
// what stops a feature from doing `Number(row.total)` somewhere and silently
// losing precision on a large invoice.

function toMinor(value: string | number | null | undefined): Minor {
  if (value === null || value === undefined || value === '') return minor(0)
  return minor(Math.round(Number(value) * 100))
}

function toMilli(value: string | number | null | undefined): Milli {
  if (value === null || value === undefined || value === '') return milli(0)
  return milli(Math.round(Number(value) * 1000))
}

/** Cost is `numeric(14,4)`, finer than money; kept as integer ten-thousandths. */
function toCost(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  return Math.round(Number(value) * 10000)
}

function toRate(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  return Number(value)
}

/** PostgREST reports failure by setting `error`; throw so callers use try/catch. */
function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw result.error
  return result.data as T
}

const MAX_LIMIT = 200

function clampLimit(limit: number | undefined, fallback: number): number {
  const value = limit ?? fallback
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)))
}

// ── Keyset pagination ─────────────────────────────────────────────────────

/**
 * Cursor for `(created_at desc, id desc)`.
 *
 * Offset paging would both slow down as the offset grows and shift rows when
 * a sale lands while the cashier scrolls — on a shop floor that is constantly.
 * The cursor is the last row's sort key, base64 so it is opaque and URL-safe.
 */
function encodeCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`)
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = atob(cursor).split('|')
    if (!createdAt || !id) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

/**
 * The one method this module needs from a query builder, named structurally.
 *
 * `PostgrestFilterBuilder` takes up to eight type parameters that describe the
 * generated schema. Naming it here would couple this file to generated types
 * the project deliberately does not use; describing the single method it
 * actually calls does not.
 */
interface Chainable<Self> {
  or(filters: string, options?: { foreignTable?: string }): Self
}

/** Apply "rows strictly after the cursor" to a time-ordered query. */
function afterCursor<T extends Chainable<T>>(builder: T, cursor: string | null | undefined): T {
  if (!cursor) return builder
  const decoded = decodeCursor(cursor)
  if (!decoded) return builder
  // Nested and() inside or() is how PostgREST expresses the tuple comparison
  // `(created_at, id) < (c, i)` — there is no row-value operator in the API.
  return builder.or(
    `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`
  )
}

function paginate<T extends { id: string; created_at: string }>(
  rows: T[],
  limit: number
): Page<T> {
  const last = rows[rows.length - 1]
  const hasMore = rows.length === limit
  return {
    items: rows,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  }
}

/**
 * Cursor for `stock_balances`, which has no `id`/`created_at` of its own —
 * it is keyed by (warehouse, variant) and updated in place. Paging on
 * `(updated_at, variant_id)` keeps the same "rows after this point" guarantee.
 */
function encodeStockCursor(updatedAt: string, variantId: string): string {
  return btoa(`${updatedAt}|${variantId}`)
}

function decodeStockCursor(cursor: string): { updatedAt: string; variantId: string } | null {
  try {
    const [updatedAt, variantId] = atob(cursor).split('|')
    if (!updatedAt || !variantId) return null
    return { updatedAt, variantId }
  } catch {
    return null
  }
}

function stockAfterCursor<T extends Chainable<T>>(builder: T, cursor: string | null | undefined): T {
  if (!cursor) return builder
  const decoded = decodeStockCursor(cursor)
  if (!decoded) return builder
  return builder.or(
    `updated_at.lt.${decoded.updatedAt},and(updated_at.eq.${decoded.updatedAt},variant_id.lt.${decoded.variantId})`
  )
}

/** Postgres `date` arrives as `YYYY-MM-DD` — keep it a string, never a Date. */
function asDate(value: string | null | undefined): string | null {
  return value ? String(value).slice(0, 10) : null
}

function stockNextCursor(rows: { updated_at: string; variant_id: string }[], limit: number): string | null {
  const last = rows[rows.length - 1]
  if (rows.length < limit || !last) return null
  return encodeStockCursor(last.updated_at, last.variant_id)
}

/** Escape the characters PostgREST treats as operators inside an `or` value. */
function likeTerm(search: string): string {
  return search.trim().replace(/[,()]/g, ' ').replace(/\s+/g, ' ')
}

// ── Catalogue ─────────────────────────────────────────────────────────────

function toSellable(row: PosCatalogRow): SellableProduct {
  return {
    productId: row.product_id,
    variantId: row.variant_id,
    name: row.name,
    variantName: row.variant_name,
    sku: row.effective_sku,
    imageUrl: row.image_url,
    price: toMinor(row.price),
    cost: toCost(row.cost),
    taxRatePercent: toRate(row.tax_rate),
    taxInclusive: row.tax_inclusive,
    trackStock: row.track_stock,
    allowNegative: row.allow_negative,
    // A variant with no balance row has never been stocked: 0, not unknown.
    availableQty: row.track_stock ? toMilli(row.available) : null,
    unitLabel: row.unit_label,
    decimalQuantity: row.decimal_quantity,
    categoryName: row.category_name,
    metadata: row.metadata ?? {},
  }
}

const CATALOG_SELECT = [
  'organization_id',
  'product_id',
  'name',
  'sku',
  'description',
  'image_url',
  'track_stock',
  'allow_negative',
  'tax_inclusive',
  'category_id',
  'category_name',
  'reorder_point',
  'metadata',
  'variant_id',
  'variant_name',
  'effective_sku',
  'price',
  'cost',
  'is_default',
  'unit_label',
  'decimal_quantity',
  'tax_rate',
  'warehouse_id',
  'available',
].join(',')

function createCatalog(client: SupabaseClient, organizationId: () => string | null): CatalogRepository {
  return {
    async searchProducts(query) {
      const limit = clampLimit(query.limit, 24)
      // Unstocked variants have a null warehouse_id and must still appear —
      // a brand-new product with no stock yet is exactly what a shop adds
      // first, and hiding it would look like a failed save.
      let builder = client
        .from('pos_catalog')
        .select(CATALOG_SELECT)
        .or(`warehouse_id.eq.${query.warehouseId},warehouse_id.is.null`)
        .order('name', { ascending: true })
        .limit(limit)

      const search = likeTerm(query.search ?? '')
      if (search) {
        builder = builder.or(`search_text.ilike.*${search}*,name.ilike.*${search}*`)
      }
      if (query.categoryId) builder = builder.eq('category_id', query.categoryId)
      if (query.onlyInStock) builder = builder.gt('available', 0)

      const rows = unwrap(await builder.returns<PosCatalogRow[]>())
      return { items: rows.map(toSellable), nextCursor: null }
    },

    async findByVariantId(variantId, warehouseId) {
      const rows = unwrap(
        await client
          .from('pos_catalog')
          .select(CATALOG_SELECT)
          .eq('variant_id', variantId)
          .or(`warehouse_id.eq.${warehouseId},warehouse_id.is.null`)
          .limit(1)
          .returns<PosCatalogRow[]>()
      )
      const row = rows[0]
      return row ? toSellable(row) : null
    },

    async findByBarcode(code, warehouseId) {
      const trimmed = code.trim()
      if (!trimmed) return null
      const hits = unwrap(
        await client
          .from('product_barcodes')
          .select('variant_id')
          .eq('code', trimmed)
          .limit(1)
          .returns<{ variant_id: string }[]>()
      )
      const variantId = hits[0]?.variant_id
      if (!variantId) return null

      const rows = unwrap(
        await client
          .from('pos_catalog')
          .select(CATALOG_SELECT)
          .eq('variant_id', variantId)
          .or(`warehouse_id.eq.${warehouseId},warehouse_id.is.null`)
          .limit(1)
          .returns<PosCatalogRow[]>()
      )
      const row = rows[0]
      return row ? toSellable(row) : null
    },

    async listCategories() {
      const rows = unwrap(
        await client
          .from('product_categories')
          .select('id,name,slug,parent_id,sort_order,is_active')
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('sort_order')
          .order('name')
          .returns<Category[]>()
      )
      return rows
    },

    async createCategory(name, parentId = null) {
      const clean = name.trim()
      if (!clean) throw new Error('A category needs a name.')
      const slug = clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'category'
      const rows = unwrap(
        await client
          .from('product_categories')
          .insert({
            organization_id: requireOrg(organizationId),
            name: clean,
            slug,
            parent_id: parentId,
            sort_order: 0,
          })
          .select('id,name,slug,parent_id,sort_order,is_active')
          .limit(1)
          .returns<Category[]>()
      )
      const category = rows[0]
      if (!category) throw new Error('The category was not created.')
      return category
    },

    async listBrands() {
      return unwrap(
        await client
          .from('product_brands')
          .select('id,name')
          .is('deleted_at', null)
          .order('name')
          .returns<Brand[]>()
      )
    },

    async createBrand(name) {
      const clean = name.trim()
      if (!clean) throw new Error('A brand needs a name.')
      const rows = unwrap(
        await client
          .from('product_brands')
          .insert({ organization_id: requireOrg(organizationId), name: clean })
          .select('id,name')
          .limit(1)
          .returns<Brand[]>()
      )
      const brand = rows[0]
      if (!brand) throw new Error('The brand was not created.')
      return brand
    },

    async listUnits() {
      return unwrap(
        await client
          .from('product_units')
          .select('id,name,symbol,is_decimal,sort_order')
          .is('deleted_at', null)
          .order('sort_order')
          .order('name')
          .returns<Unit[]>()
      )
    },

    async listTaxes() {
      return unwrap(
        await client
          .from('taxes')
          .select('id,name,rate,is_inclusive,is_active')
          .eq('is_active', true)
          .order('rate')
          .returns<Tax[]>()
      )
    },

    async listAllTaxes() {
      return unwrap(
        await client
          .from('taxes')
          .select('id,name,rate,is_inclusive,is_active')
          .order('is_active', { ascending: false })
          .order('rate')
          .returns<Tax[]>()
      )
    },

    async createTax(name, rate, isInclusive) {
      return unwrap(
        await client
          .from('taxes')
          .insert({
            organization_id: requireOrg(organizationId),
            name: name.trim(),
            rate: numeric(rate, 4),
            is_inclusive: isInclusive,
          })
          .select('id,name,rate,is_inclusive,is_active')
          .single()
          .returns<Tax>()
      )
    },

    async updateTax(id, draft) {
      const patch: Record<string, unknown> = {}
      if (draft.name !== undefined) patch.name = draft.name.trim()
      if (draft.rate !== undefined) patch.rate = numeric(draft.rate, 4)
      if (draft.is_inclusive !== undefined) patch.is_inclusive = draft.is_inclusive
      if (draft.is_active !== undefined) patch.is_active = draft.is_active
      return unwrap(
        await client
          .from('taxes')
          .update(patch)
          .eq('id', id)
          .select('id,name,rate,is_inclusive,is_active')
          .single()
          .returns<Tax>()
      )
    },

    async listPaymentMethods() {
      return unwrap(
        await client
          .from('payment_methods')
          .select('id,key,name,type,is_cash,is_active,sort_order,icon,config')
          .eq('is_active', true)
          .is('deleted_at', null)
          .order('sort_order')
          .returns<PaymentMethod[]>()
      )
    },

    async listAllPaymentMethods() {
      return unwrap(
        await client
          .from('payment_methods')
          .select('id,key,name,type,is_cash,is_active,sort_order,icon,config')
          .is('deleted_at', null)
          .order('sort_order')
          .returns<PaymentMethod[]>()
      )
    },

    async updatePaymentMethod(id, draft) {
      const patch: Record<string, unknown> = {}
      if (draft.name !== undefined) patch.name = draft.name.trim()
      if (draft.is_active !== undefined) patch.is_active = draft.is_active
      if (draft.sort_order !== undefined) patch.sort_order = draft.sort_order
      if (draft.icon !== undefined) patch.icon = draft.icon
      if (draft.config !== undefined) patch.config = draft.config
      return unwrap(
        await client
          .from('payment_methods')
          .update(patch)
          .eq('id', id)
          .select('id,key,name,type,is_cash,is_active,sort_order,icon,config')
          .single()
          .returns<PaymentMethod>()
      )
    },
  }
  // `organizationId` is intentionally unused: RLS scopes every read to the
  // caller's organization, so filtering again in the client would be a second
  // source of truth that can disagree with the database.
  void organizationId
}

// ── Products ──────────────────────────────────────────────────────────────

const PRODUCT_SELECT = [
  'id',
  'name',
  'sku',
  'description',
  'category_id',
  'brand_id',
  'unit_id',
  'tax_id',
  'selling_price',
  'cost_price',
  'tax_inclusive',
  'reorder_point',
  'track_stock',
  'allow_negative',
  'is_active',
  'image_url',
  'metadata',
  'created_at',
].join(',')

/**
 * A SKU for a database that has not run migration 054 yet.
 *
 * Deliberately the *fallback*, not the mechanism: numbering belongs next to a
 * row lock, and this has none — two tablets creating a product in the same
 * second can land on the same code. It reads the shop's current high-water
 * mark and probes for a free slot, which is good enough to stop the column
 * being null on a live shop today, and becomes dead code the moment the
 * trigger is installed.
 *
 * Returns null rather than throwing: a product that saved successfully must
 * not be reported as failed because its code could not be invented.
 */
async function fallbackSku(
  client: SupabaseClient,
  organizationId: string,
  name: string
): Promise<string | null> {
  // ASCII letters only. A Bangla name has none, and `-0007` is not a code.
  const letters = (name ?? '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
  const prefix = letters.length >= 2 ? letters : 'SKU'
  try {
    const { count } = await client
      .from('products')
      .select('id', { count: 'exact', head: true })
    let n = (count ?? 0) + 1
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `${prefix}-${String(n).padStart(4, '0')}`
      const { data } = await client
        .from('products')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('sku', candidate)
        .limit(1)
      if (!data || data.length === 0) return candidate
      n += 1
    }
    return null
  } catch {
    return null
  }
}

/** `numeric` goes back as a fixed string, never a float in scientific form. */
function numeric(value: number, decimals: number): string {
  return value.toFixed(decimals)
}

/**
 * The tenant id every write must carry.
 *
 * `organization_id` is NOT NULL with no column default and there is no
 * `app.org_id()` SQL helper, so PostgREST cannot infer it. Omitting it does
 * not produce a not-null error either — the RLS insert policy evaluates
 * `app.in_org(null)` and answers 42501, which reads like a permissions bug
 * when it is really a missing column. Say so plainly instead.
 */
function requireOrg(organizationId: () => string | null): string {
  const id = organizationId()
  if (!id) {
    throw new Error('No active organization. Select a shop before saving.')
  }
  return id
}

function createProducts(
  client: SupabaseClient,
  organizationId: () => string | null
): ProductRepository {
  return {
    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('products')
        .select(PRODUCT_SELECT)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)

      const search = query.search?.trim()
      if (search) builder = builder.ilike('search_text', `%${search.toLowerCase()}%`)
      if (query.categoryId) builder = builder.eq('category_id', query.categoryId)

      return paginate(unwrap(await builder.returns<ProductRow[]>()), limit)
    },

    async get(id) {
      const rows = unwrap(
        await client
          .from('products')
          .select(PRODUCT_SELECT)
          .eq('id', id)
          .is('deleted_at', null)
          .limit(1)
          .returns<ProductRow[]>()
      )
      return rows[0] ?? null
    },

    async getWithVariants(id) {
      const product = await this.get(id)
      if (!product) return null
      const variants = unwrap(
        await client
          .from('product_variants')
          .select('id,product_id,is_default,sku,name_suffix,price_override,cost_override,is_active')
          .eq('product_id', id)
          .is('deleted_at', null)
          .order('is_default', { ascending: false })
          .returns<VariantRow[]>()
      )
      return { product, variants }
    },

    async listBarcodes(productId) {
      const detail = await this.getWithVariants(productId)
      const variantIds = detail?.variants.map((variant) => variant.id) ?? []
      if (variantIds.length === 0) return []
      const rows = unwrap(
        await client
          .from('product_barcodes')
          .select('id,variant_id,code,is_primary')
          .in('variant_id', variantIds)
          .order('is_primary', { ascending: false })
          .order('code')
          .returns<{ id: string; variant_id: string; code: string; is_primary: boolean }[]>()
      )
      return rows.map(
        (row): ProductBarcode => ({
          id: row.id,
          variantId: row.variant_id,
          code: row.code,
          isPrimary: row.is_primary,
        })
      )
    },

    async replaceBarcodes(variantId, codes) {
      const clean = [...new Set(codes.map((code) => code.trim()).filter(Boolean))]
      const removed = await client.from('product_barcodes').delete().eq('variant_id', variantId)
      if (removed.error) throw removed.error
      if (clean.length === 0) return []
      const rows = unwrap(
        await client
          .from('product_barcodes')
          .insert(
            clean.map((code, index) => ({
              organization_id: requireOrg(organizationId),
              variant_id: variantId,
              code,
              is_primary: index === 0,
            }))
          )
          .select('id,variant_id,code,is_primary')
          .returns<{ id: string; variant_id: string; code: string; is_primary: boolean }[]>()
      )
      return rows.map(
        (row): ProductBarcode => ({
          id: row.id,
          variantId: row.variant_id,
          code: row.code,
          isPrimary: row.is_primary,
        })
      )
    },

    async create(draft) {
      // The default variant is created in the same round trip. A product
      // without one cannot be sold — `sale_items.variant_id` is NOT NULL and
      // `complete_sale` resolves stock per variant — so leaving that to a
      // second call would leave a window where the product is unsellable.
      const inserted = unwrap(
        await client
          .from('products')
          .insert({
            organization_id: requireOrg(organizationId),
            name: draft.name,
            sku: draft.sku ?? null,
            description: draft.description ?? null,
            category_id: draft.category_id ?? null,
            brand_id: draft.brand_id ?? null,
            unit_id: draft.unit_id ?? null,
            tax_id: draft.tax_id ?? null,
            selling_price: numeric(draft.selling_price, 2),
            cost_price: numeric(draft.cost_price, 4),
            tax_inclusive: draft.tax_inclusive,
            reorder_point: numeric(draft.reorder_point, 3),
            track_stock: draft.track_stock,
            allow_negative: draft.allow_negative,
            is_active: draft.is_active,
            image_url: draft.image_url ?? null,
            metadata: draft.metadata,
          })
          .select(PRODUCT_SELECT)
          .limit(1)
          .returns<ProductRow[]>()
      )
      const product = inserted[0]
      if (!product) throw new Error('The product was not created')

      const variantError = await client
        .from('product_variants')
        .insert({
          organization_id: requireOrg(organizationId),
          product_id: product.id,
          is_default: true,
        })
      if (variantError.error) throw variantError.error

      // Migration 054 fills a blank SKU with a locked, per-shop counter. Until
      // a project has run it the column comes back null, and the form has been
      // promising "auto-generated if blank" the whole time. This bridges that
      // gap and then stops firing for good: once the trigger exists, `sku` is
      // already set by the time the insert returns.
      if (!product.sku) {
        const generated = await fallbackSku(client, requireOrg(organizationId), draft.name)
        if (generated) {
          const patched = unwrap(
            await client
              .from('products')
              .update({ sku: generated })
              .eq('id', product.id)
              .select(PRODUCT_SELECT)
              .limit(1)
              .returns<ProductRow[]>()
          )
          return patched[0] ?? { ...product, sku: generated }
        }
      }

      return product
    },

    async update(id, draft) {
      const patch: Record<string, unknown> = {}
      if (draft.name !== undefined) patch.name = draft.name
      if (draft.sku !== undefined) patch.sku = draft.sku
      if (draft.description !== undefined) patch.description = draft.description
      if (draft.category_id !== undefined) patch.category_id = draft.category_id
      if (draft.brand_id !== undefined) patch.brand_id = draft.brand_id
      if (draft.unit_id !== undefined) patch.unit_id = draft.unit_id
      if (draft.tax_id !== undefined) patch.tax_id = draft.tax_id
      if (draft.selling_price !== undefined) patch.selling_price = numeric(draft.selling_price, 2)
      if (draft.cost_price !== undefined) patch.cost_price = numeric(draft.cost_price, 4)
      if (draft.tax_inclusive !== undefined) patch.tax_inclusive = draft.tax_inclusive
      if (draft.reorder_point !== undefined) patch.reorder_point = numeric(draft.reorder_point, 3)
      if (draft.track_stock !== undefined) patch.track_stock = draft.track_stock
      if (draft.allow_negative !== undefined) patch.allow_negative = draft.allow_negative
      if (draft.is_active !== undefined) patch.is_active = draft.is_active
      if (draft.image_url !== undefined) patch.image_url = draft.image_url
      if (draft.metadata !== undefined) patch.metadata = draft.metadata

      const updated = unwrap(
        await client
          .from('products')
          .update(patch)
          .eq('id', id)
          .select(PRODUCT_SELECT)
          .limit(1)
          .returns<ProductRow[]>()
      )
      const product = updated[0]
      if (!product) throw new Error('The product was not updated')
      return product
    },

    async archive(id) {
      const { error } = await client
        .from('products')
        .update({ deleted_at: new Date().toISOString(), is_active: false })
        .eq('id', id)
      if (error) throw error
    },

    /**
     * Hard delete, through `delete_product` (migration 053).
     *
     * Not `.from('products').delete()`: `stock_movements` and
     * `stock_transfer_items` reference the product with no cascade, and RLS
     * makes both SELECT-only for a browser — so the direct delete fails with
     * a foreign-key violation on every product that was ever stocked. The
     * function clears them under `security definer` and refuses when a sale,
     * return or purchase is involved.
     *
     * The fallback matters in the field: a project that has not run 053 yet
     * answers PGRST202 ("function not found"), and a product that was never
     * stocked still deletes cleanly the plain way.
     */
    async remove(id) {
      const { error } = await client.rpc('delete_product', { p_product_id: id })
      if (!error) return
      if (error.code !== 'PGRST202') throw error

      const direct = await client.from('products').delete().eq('id', id)
      if (!direct.error) return
      if (direct.error.code === '23503') {
        throw new Error(
          'This product has stock history, and the database has not been ' +
            'migrated to delete it (migration 053). Archive it, or apply the ' +
            'migration and try again.'
        )
      }
      throw direct.error
    },

    /**
     * One query for the whole page. `stock_balances` has a row per warehouse,
     * so the sum happens here rather than in five round trips.
     */
    async onHand(productIds, warehouseId) {
      if (productIds.length === 0) return {}
      let query = client
        .from('stock_balances')
        .select('product_id, quantity')
        .in('product_id', productIds)
      if (warehouseId) query = query.eq('warehouse_id', warehouseId)
      const rows = unwrap(await query.returns<{ product_id: string; quantity: string }[]>())
      const totals: Record<string, Milli> = {}
      for (const row of rows) {
        const previous = totals[row.product_id] ?? milli(0)
        totals[row.product_id] = milli(previous + toMilli(row.quantity))
      }
      return totals
    },

    async duplicate(id) {
      const source = await this.get(id)
      if (!source) throw new Error('Product not found')
      return this.create({
        name: `${source.name} (copy)`,
        // No SKU: it is unique per organization and a copied code would
        // either collide or silently create two products with one barcode.
        // `create` supplies the tenant id, so it is not repeated here.
        sku: null,
        description: source.description,
        category_id: source.category_id,
        brand_id: source.brand_id,
        unit_id: source.unit_id,
        tax_id: source.tax_id,
        selling_price: Number(source.selling_price),
        cost_price: Number(source.cost_price),
        tax_inclusive: source.tax_inclusive,
        reorder_point: Number(source.reorder_point),
        track_stock: source.track_stock,
        allow_negative: source.allow_negative,
        is_active: true,
        image_url: source.image_url,
        metadata: { ...source.metadata, duplicated_from: id },
      })
    },
  }
}

// ── Sales ─────────────────────────────────────────────────────────────────

function createSales(client: SupabaseClient): SaleRepository {
  return {
    async complete(input) {
      // Named arguments: with ten parameters and several optional ones, a
      // positional call silently mis-binds when a parameter is inserted.
      const args: Record<string, unknown> = {
        p_branch_id: input.branchId,
        p_items: input.items,
        p_payments: input.payments,
      }
      if (input.registerId) args.p_register_id = input.registerId
      if (input.customerId) args.p_customer_id = input.customerId
      if (input.warehouseId) args.p_warehouse_id = input.warehouseId
      if (input.discountType) args.p_discount_type = input.discountType
      if (input.discountValue !== undefined && input.discountValue > 0) {
        args.p_discount_value = input.discountValue
      }
      if (input.note) args.p_note = input.note
      if (input.heldSaleId) args.p_held_sale_id = input.heldSaleId
      // The offline queue's identity for this sale (migration 044). Sending it
      // is what makes a resend after an unclear outcome return the sale that
      // was already written rather than creating a second one.
      if (input.clientRef) args.p_client_ref = input.clientRef

      const { data, error } = await client.rpc('complete_sale', args)
      if (error) throw error
      return data as CompletedSale
    },

    async hold(input) {
      const args: Record<string, unknown> = {
        p_branch_id: input.branchId,
        p_items: input.items,
      }
      if (input.customerId) args.p_customer_id = input.customerId
      if (input.note) args.p_note = input.note

      const { data, error } = await client.rpc('hold_sale', args)
      if (error) throw error
      return data as string
    },

    async resume(saleId) {
      const { data, error } = await client.rpc('resume_sale', { p_sale_id: saleId })
      if (error) throw error
      return data as ResumedSale
    },

    async discard(saleId) {
      const { error } = await client.rpc('discard_held_sale', { p_sale_id: saleId })
      if (error) throw error
    },

    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('sales')
        .select(
          'id,invoice_no,status,branch_id,register_id,session_id,customer_id,currency,' +
            'subtotal,discount_total,discount_type,discount_value,tax_total,total,' +
            'paid_total,change_due,cogs,profit,note,created_at,completed_at,created_by,' +
            'customer:customers(id,name,phone)'
        )
        .eq('branch_id', query.branchId)
        .not('status', 'in', '(DRAFT,CANCELLED)')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)
      if (query.status && query.status.length > 0) {
        builder = builder.in('status', query.status)
      }

      return paginate(unwrap(await builder.returns<SaleRow[]>()), limit)
    },

    async get(id) {
      const rows = unwrap(
        await client
          .from('sales')
          .select(
            'id,invoice_no,status,branch_id,register_id,session_id,customer_id,currency,' +
              'subtotal,discount_total,discount_type,discount_value,tax_total,total,' +
              'paid_total,change_due,cogs,profit,note,created_at,completed_at,created_by,' +
              'customer:customers(id,name,phone),' +
              'items:sale_items(id,variant_id,product_id,product_name,variant_name,sku,' +
              'unit_label,quantity,unit_price,unit_cost,discount_type,discount_value,' +
              'discount_total,tax_rate,tax_total,line_total,line_cogs,returned_qty),' +
              // `received_at`, not `created_at`: `sale_payments` is the one
              // table in the schema that names its timestamp after the event
              // rather than after the row, and asking for the wrong one made
              // every completed sale answer `42703` *after* the money was
              // taken.
              'payments:sale_payments(id,method_id,amount,reference,received_at,' +
              'method:payment_methods(key,name))'
          )
          .eq('id', id)
          .limit(1)
          .returns<SaleRow[]>()
      )
      return rows[0] ?? null
    },

    async held(branchId) {
      return unwrap(
        await client
          .from('sales')
          .select(
            'id,invoice_no,status,branch_id,register_id,session_id,customer_id,currency,' +
              'subtotal,discount_total,discount_type,discount_value,tax_total,total,' +
              'paid_total,change_due,cogs,profit,note,created_at,completed_at,created_by,' +
              'customer:customers(id,name,phone)'
          )
          .eq('branch_id', branchId)
          .eq('status', 'HELD')
          .order('created_at', { ascending: false })
          .returns<SaleRow[]>()
      )
    },

    async listAll(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('sales_detail')
        .select('id,invoice_no,status,customer_id,customer_name,branch_name,total,paid_total,created_at,completed_at')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)

      // The Sales screen shows the till's branch by default; `sales_detail`
      // carries `branch_id`, so this is a filter rather than a schema change.
      // Omitting `branchId` keeps the cross-branch view for anywhere that wants it.
      if (query.branchId) builder = builder.eq('branch_id', query.branchId)
      if (query.status) builder = builder.eq('status', query.status)
      const search = query.search?.trim()
      if (search) {
        builder = builder.or(
          `invoice_no.ilike.%${likeTerm(search)}%,customer_name.ilike.%${likeTerm(search)}%`
        )
      }
      if (query.from) builder = builder.gte('created_at', query.from)
      if (query.to) builder = builder.lte('created_at', query.to)

      const rows = unwrap(
        await builder.returns<
          {
            id: string
            invoice_no: string
            status: string
            customer_id: string | null
            customer_name: string | null
            branch_name: string | null
            total: string
            paid_total: string
            created_at: string
            completed_at: string | null
          }[]
        >()
      )
      const items = rows.map(
        (row): SalesListRow => ({
          id: row.id,
          invoiceNo: row.invoice_no,
          status: row.status,
          customerId: row.customer_id,
          customerName: row.customer_name,
          branchName: row.branch_name,
          total: toMinor(row.total),
          paidTotal: toMinor(row.paid_total),
          createdAt: row.created_at,
          completedAt: row.completed_at,
        })
      )
      return { items, nextCursor: paginate(rows, limit).nextCursor }
    },

    async detail(id) {
      const saleRows = unwrap(
        await client
          .from('sales_detail')
          .select('id,invoice_no,status,customer_id,customer_name,branch_name,total,paid_total,created_at,completed_at')
          .eq('id', id)
          .limit(1)
          .returns<
            {
              id: string
              invoice_no: string
              status: string
              customer_id: string | null
              customer_name: string | null
              branch_name: string | null
              total: string
              paid_total: string
              created_at: string
              completed_at: string | null
            }[]
          >()
      )
      const sale = saleRows[0]
      if (!sale) return null

      // Returned quantities matter here more than anywhere else: the refund
      // dialog must not offer to give back something already given back, and
      // the database would refuse it anyway.
      type SaleItemRow = {
        id: string
        product_name: string
        variant_name: string | null
        quantity: string
        returned_qty: string
        unit_price: string
        line_total: string
      }

      const itemColumns = 'id,product_name,variant_name,quantity,returned_qty,unit_price,line_total'

      /**
       * Lines in the order they were rung up.
       *
       * `sale_items.created_at` only exists from migration 055; before it, this
       * query answered `42703 column does not exist` and the whole sale failed
       * to open — a refund screen taken down by a sort key. So the order is
       * attempted and the unordered result accepted when the column is not
       * there yet, which keeps a shop that has not run the migration working
       * rather than locking it out of its own history.
       *
       * The ordering is not cosmetic: refunding a line updates `returned_qty`,
       * and an updated row moves to the end of the physical order, so without
       * a sort key the list reshuffles itself under the cashier's finger.
       */
      let itemResult = await client
        .from('sale_items')
        .select(itemColumns)
        .eq('sale_id', id)
        .order('created_at')
        .returns<SaleItemRow[]>()

      if (itemResult.error && /created_at/.test(itemResult.error.message)) {
        itemResult = await client
          .from('sale_items')
          .select(itemColumns)
          .eq('sale_id', id)
          .returns<SaleItemRow[]>()
      }

      const itemRows = unwrap(itemResult)

      const paymentRows = unwrap(
        await client
          .from('sale_payments')
          .select('id,amount,received_at,payment_methods(name)')
          .eq('sale_id', id)
          .order('received_at')
          .returns<
            {
              id: string
              amount: string
              received_at: string
              payment_methods: { name: string } | { name: string }[] | null
            }[]
          >()
      )

      const returnRows = unwrap(
        await client
          .from('sale_returns')
          .select('id,return_no,created_at,reason,restock,refund_total,sale_return_items(sale_item_id,quantity,refund_amount,sale_items(product_name))')
          .eq('sale_id', id)
          .order('created_at', { ascending: false })
          .returns<
            {
              id: string
              return_no: string
              created_at: string
              reason: string | null
              restock: boolean
              refund_total: string
              sale_return_items:
                | {
                    sale_item_id: string
                    quantity: string
                    refund_amount: string
                    sale_items: { product_name: string } | { product_name: string }[] | null
                  }[]
                | null
            }[]
          >()
      )

      const detail: SaleDetail = {
        sale: {
          id: sale.id,
          invoiceNo: sale.invoice_no,
          status: sale.status,
          customerId: sale.customer_id,
          customerName: sale.customer_name,
          branchName: sale.branch_name,
          total: toMinor(sale.total),
          paidTotal: toMinor(sale.paid_total),
          createdAt: sale.created_at,
          completedAt: sale.completed_at,
        },
        items: itemRows.map((row) => ({
          id: row.id,
          productName: row.product_name,
          variantName: row.variant_name,
          quantity: toMilli(row.quantity),
          returnedQty: toMilli(row.returned_qty),
          unitPrice: toMinor(row.unit_price),
          lineTotal: toMinor(row.line_total),
        })),
        payments: paymentRows.map((row) => ({
          id: row.id,
          methodName: embedded(row.payment_methods)?.name ?? null,
          amount: toMinor(row.amount),
          receivedAt: row.received_at,
        })),
        returns: returnRows.map(
          (row): SaleReturnRow => ({
            id: row.id,
            returnNo: row.return_no,
            createdAt: row.created_at,
            reason: row.reason,
            restock: row.restock,
            refundTotal: toMinor(row.refund_total),
            items: (row.sale_return_items ?? []).map((item) => ({
              saleItemId: item.sale_item_id,
              quantity: toMilli(item.quantity),
              refundAmount: toMinor(item.refund_amount),
              productName: embedded(item.sale_items)?.product_name ?? 'Item',
            })),
          })
        ),
      }
      return detail
    },

    async byCustomer(customerId, query) {
      const limit = clampLimit(query?.limit, 25)
      let builder = client
        .from('sales')
        .select(
          'id,invoice_no,status,branch_id,register_id,session_id,customer_id,currency,' +
            'subtotal,discount_total,discount_type,discount_value,tax_total,total,' +
            'paid_total,change_due,cogs,profit,note,created_at,completed_at,created_by'
        )
        .eq('customer_id', customerId)
        .in('status', ['COMPLETED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'])
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query?.cursor)
      return paginate(unwrap(await builder.returns<SaleRow[]>()), limit)
    },
  }
}

// ── Customers ─────────────────────────────────────────────────────────────

const CUSTOMER_SELECT =
  'id,name,phone,email,address,credit_limit,balance,store_credit,note,created_at'

function createCustomers(
  client: SupabaseClient,
  organizationId: () => string | null
): CustomerRepository {
  return {
    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('customers')
        .select(CUSTOMER_SELECT)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)
      const search = query.search?.trim()
      if (search) {
        builder = builder.or(`name.ilike.*${likeTerm(search)}*,phone.ilike.*${likeTerm(search)}*`)
      }

      return paginate(unwrap(await builder.returns<CustomerRow[]>()), limit)
    },

    async get(id) {
      const rows = unwrap(
        await client
          .from('customers')
          .select(CUSTOMER_SELECT)
          .eq('id', id)
          .is('deleted_at', null)
          .limit(1)
          .returns<CustomerRow[]>()
      )
      return rows[0] ?? null
    },

    async create(draft) {
      const inserted = unwrap(
        await client
          .from('customers')
          .insert({
            organization_id: requireOrg(organizationId),
            name: draft.name,
            phone: draft.phone ?? null,
            email: draft.email ?? null,
            address: draft.address ?? null,
            note: draft.note ?? null,
          })
          .select(CUSTOMER_SELECT)
          .limit(1)
          .returns<CustomerRow[]>()
      )
      const customer = inserted[0]
      if (!customer) throw new Error('The customer was not created')
      return customer
    },

    async update(id, draft) {
      const patch: Record<string, unknown> = {}
      if (draft.name !== undefined) patch.name = draft.name
      if (draft.phone !== undefined) patch.phone = draft.phone
      if (draft.email !== undefined) patch.email = draft.email
      if (draft.address !== undefined) patch.address = draft.address
      if (draft.note !== undefined) patch.note = draft.note
      const updated = unwrap(
        await client
          .from('customers')
          .update(patch)
          .eq('id', id)
          .select(CUSTOMER_SELECT)
          .limit(1)
          .returns<CustomerRow[]>()
      )
      const customer = updated[0]
      if (!customer) throw new Error('The customer was not updated')
      return customer
    },

    async collectPayment(input) {
      const result = unwrap(
        await client.rpc('collect_customer_payment', {
          p_customer_id: input.customerId,
          p_amount: minorToNumber(input.amount),
          p_method_id: input.methodId,
          p_sale_id: input.saleId ?? null,
          p_reference: input.reference ?? null,
          p_note: null,
        })
      ) as { collected: string | number; customer_balance: string | number; sales_settled: number }
      return {
        collected: toMinor(result.collected),
        balance: toMinor(result.customer_balance),
        settledSales: result.sales_settled,
      }
    },
  }
}

// ── Register ──────────────────────────────────────────────────────────────

const SESSION_SELECT =
  'id,register_id,branch_id,opened_at,closed_at,opening_cash,closing_cash,' +
  'expected_cash,sales_cash,cash_in,cash_out,status,opened_by'

function createRegisters(client: SupabaseClient): RegisterRepository {
  return {
    async list(branchId) {
      return unwrap(
        await client
          .from('registers')
          .select('id,branch_id,name,is_active')
          .eq('branch_id', branchId)
          .eq('is_active', true)
          .order('name')
          .returns<RegisterRow[]>()
      )
    },

    async currentSession(branchId) {
      const rows = unwrap(
        await client
          .from('register_sessions')
          .select(SESSION_SELECT)
          .eq('branch_id', branchId)
          .eq('status', 'OPEN')
          .order('opened_at', { ascending: false })
          .limit(1)
          .returns<RegisterSessionRow[]>()
      )
      return rows[0] ?? null
    },

    async open(registerId, openingCash, note) {
      const args: Record<string, unknown> = {
        p_register_id: registerId,
        p_opening_cash: openingCash / 100,
      }
      if (note) args.p_note = note
      const { data, error } = await client.rpc('open_register', args)
      if (error) throw error
      return data as string
    },

    async close(sessionId, closingCash, note) {
      const args: Record<string, unknown> = {
        p_session_id: sessionId,
        p_closing_cash: closingCash / 100,
      }
      if (note) args.p_note = note
      const { error } = await client.rpc('close_register', args)
      if (error) throw error
    },

    async cashMovement(sessionId, amount, direction, note) {
      const args: Record<string, unknown> = {
        p_session_id: sessionId,
        p_amount: amount / 100,
        p_direction: direction,
      }
      if (note) args.p_note = note
      const { error } = await client.rpc('register_cash_movement', args)
      if (error) throw error
    },

    async sessions(branchId, limit = 30) {
      const rows = unwrap(
        await client
          .from('register_session_summary')
          .select(
            'id,register_id,register_name,branch_id,opened_at,closed_at,is_open,opening_cash,' +
              'closing_cash,variance,sales_total,sale_count,refund_total,expense_total'
          )
          .eq('branch_id', branchId)
          .order('opened_at', { ascending: false })
          .limit(clampLimit(limit, 30))
          .returns<
            {
              id: string
              register_id: string
              register_name: string | null
              branch_id: string
              opened_at: string
              closed_at: string | null
              is_open: boolean
              opening_cash: string
              closing_cash: string | null
              variance: string | null
              sales_total: string
              sale_count: number
              refund_total: string
              expense_total: string
            }[]
          >()
      )
      return rows.map(
        (row): RegisterSessionSummary => ({
          id: row.id,
          registerId: row.register_id,
          registerName: row.register_name,
          branchId: row.branch_id,
          openedAt: row.opened_at,
          closedAt: row.closed_at,
          isOpen: row.is_open,
          openingCash: toMinor(row.opening_cash),
          closingCash: row.closing_cash === null ? null : toMinor(row.closing_cash),
          variance: row.variance === null ? null : toMinor(row.variance),
          salesTotal: toMinor(row.sales_total),
          saleCount: Number(row.sale_count),
          refundTotal: toMinor(row.refund_total),
          expenseTotal: toMinor(row.expense_total),
        })
      )
    },

    async report(sessionId) {
      const raw = unwrap(await client.rpc('register_session_report', { p_session_id: sessionId })) as {
        session_id: string
        is_open: boolean
        opened_at: string
        closed_at: string | null
        opening_cash: string
        cash_in: string
        cash_out: string
        sales_cash: string
        refund_cash: string
        expense_cash: string
        expected_cash: string
        closing_cash: string | null
        variance: string | null
        sale_count: number
        sales_total: string
        refund_total: string
        expense_total: string
        by_method: { method_id: string; method: string; is_cash: boolean; amount: string; count: number }[]
      }
      return {
        sessionId: raw.session_id,
        isOpen: raw.is_open,
        openedAt: raw.opened_at,
        closedAt: raw.closed_at,
        openingCash: toMinor(raw.opening_cash),
        cashIn: toMinor(raw.cash_in),
        cashOut: toMinor(raw.cash_out),
        salesCash: toMinor(raw.sales_cash),
        refundCash: toMinor(raw.refund_cash),
        expenseCash: toMinor(raw.expense_cash),
        expectedCash: toMinor(raw.expected_cash),
        closingCash: raw.closing_cash === null ? null : toMinor(raw.closing_cash),
        variance: raw.variance === null ? null : toMinor(raw.variance),
        saleCount: Number(raw.sale_count),
        salesTotal: toMinor(raw.sales_total),
        refundTotal: toMinor(raw.refund_total),
        expenseTotal: toMinor(raw.expense_total),
        byMethod: (raw.by_method ?? []).map((method) => ({
          methodId: method.method_id,
          method: method.method,
          isCash: method.is_cash,
          amount: toMinor(method.amount),
          count: Number(method.count),
        })),
      } satisfies RegisterReport
    },
  }
}

// ── Organization ──────────────────────────────────────────────────────────

function normaliseStaffRows(value: unknown): StaffRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row): StaffRow[] => {
    if (typeof row !== 'object' || row === null) return []
    const record = row as Record<string, unknown>
    const roles = Array.isArray(record.roles)
      ? record.roles.flatMap((role) => {
          if (typeof role !== 'object' || role === null) return []
          const item = role as Record<string, unknown>
          return typeof item.id === 'string' && typeof item.key === 'string' && typeof item.name === 'string'
            ? [{ id: item.id, key: item.key, name: item.name }]
            : []
        })
      : []
    const branches = Array.isArray(record.branches)
      ? record.branches.flatMap((branch) => {
          if (typeof branch !== 'object' || branch === null) return []
          const item = branch as Record<string, unknown>
          return typeof item.id === 'string' && typeof item.name === 'string' ? [{ id: item.id, name: item.name }] : []
        })
      : []
    if (typeof record.email !== 'string' || typeof record.kind !== 'string') return []
    return [
      {
        kind: record.kind === 'pending' ? 'pending' : 'member',
        userId: typeof record.user_id === 'string' ? record.user_id : null,
        email: record.email,
        name: typeof record.name === 'string' ? record.name : record.email,
        isActive: record.is_active === true,
        roles,
        branches,
        invitationId: typeof record.invitation_id === 'string' ? record.invitation_id : null,
        invitedAt: typeof record.invited_at === 'string' ? record.invited_at : null,
        expiresAt: typeof record.expires_at === 'string' ? record.expires_at : null,
      },
    ]
  })
}

async function replaceRolePermissions(
  client: SupabaseClient,
  organizationId: string,
  roleId: string,
  permissionKeys: string[]
): Promise<void> {
  unwrap(
    await client.rpc('set_role_permissions', {
      p_organization_id: organizationId,
      p_role_id: roleId,
      p_permission_keys: permissionKeys,
    })
  )
}

function createOrganization(
  client: SupabaseClient,
  organizationId: () => string | null
): OrganizationRepository {
  return {
    async salesFloor(branchId) {
      const branches = unwrap(
        await client
          .from('branches')
          .select('id,name')
          .eq('id', branchId)
          .is('deleted_at', null)
          .limit(1)
          .returns<{ id: string; name: string }[]>()
      )
      const branch = branches[0]
      if (!branch) throw new Error('Branch not found')

      // The retail-floor warehouse first, because that is the one
      // complete_sale decrements when the client does not name one.
      const warehouses = unwrap(
        await client
          .from('warehouses')
          .select('id,name,is_retail_floor')
          .eq('branch_id', branchId)
          .is('deleted_at', null)
          .order('is_retail_floor', { ascending: false })
          .returns<{ id: string; name: string }[]>()
      )
      const warehouse = warehouses[0]
      if (!warehouse) throw new Error('This branch has no stock location')

      const registers = unwrap(
        await client
          .from('registers')
          .select('id,name')
          .eq('branch_id', branchId)
          .eq('is_active', true)
          .order('name')
          .returns<{ id: string; name: string }[]>()
      )

      // A register session is open while `closed_at` is null. There is no
      // `status` column on this table — filtering on one made PostgREST answer
      // 400 (column does not exist), which failed the whole floor resolve and
      // left the POS stuck on "The shop is still loading" for every shop.
      const sessions = unwrap(
        await client
          .from('register_sessions')
          .select('id')
          .eq('branch_id', branchId)
          .is('closed_at', null)
          .order('opened_at', { ascending: false })
          .limit(1)
          .returns<{ id: string }[]>()
      )

      return {
        branchId: branch.id,
        branchName: branch.name,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        registerId: registers[0]?.id ?? null,
        registerName: registers[0]?.name ?? null,
        sessionId: sessions[0]?.id ?? null,
      }
    },

    async listBranches() {
      return unwrap(
        await client
          .from('branches')
          .select('id,name,code,is_primary')
          .is('deleted_at', null)
          .order('is_primary', { ascending: false })
          .order('name')
          .returns<{ id: string; name: string; code: string | null; is_primary: boolean }[]>()
      )
    },

    async getSettings() {
      const id = requireOrg(organizationId)
      const row = unwrap(
        await client
          .from('organizations')
          .select('id,name,slug,currency,timezone,locale,logo_url,settings')
          .eq('id', id)
          .single()
          .returns<{ id: string; name: string; slug: string; currency: string; timezone: string; locale: string; logo_url: string | null; settings: Record<string, unknown> }>()
      )
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        currency: row.currency,
        timezone: row.timezone,
        locale: row.locale,
        logoUrl: row.logo_url,
        settings: row.settings ?? {},
      } satisfies OrganizationSettings
    },

    async updateSettings(input) {
      const id = requireOrg(organizationId)
      const patch: Record<string, unknown> = {}
      if (input.name !== undefined) patch.name = input.name.trim()
      if (input.currency !== undefined) patch.currency = input.currency.toUpperCase()
      if (input.timezone !== undefined) patch.timezone = input.timezone
      if (input.locale !== undefined) patch.locale = input.locale
      if (input.logoUrl !== undefined) patch.logo_url = input.logoUrl
      if (input.settings !== undefined) patch.settings = input.settings
      const row = unwrap(
        await client
          .from('organizations')
          .update(patch)
          .eq('id', id)
          .select('id,name,slug,currency,timezone,locale,logo_url,settings')
          .single()
          .returns<{ id: string; name: string; slug: string; currency: string; timezone: string; locale: string; logo_url: string | null; settings: Record<string, unknown> }>()
      )
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        currency: row.currency,
        timezone: row.timezone,
        locale: row.locale,
        logoUrl: row.logo_url,
        settings: row.settings ?? {},
      } satisfies OrganizationSettings
    },

    async listStaff() {
      const data = unwrap(await client.rpc('list_staff', { p_organization_id: requireOrg(organizationId) })) as unknown
      return normaliseStaffRows(data)
    },

    async inviteStaff(email, roleId, branchId = null) {
      const data = unwrap(
        await client.rpc('invite_staff', {
          p_organization_id: requireOrg(organizationId),
          p_email: email,
          p_role_id: roleId,
          p_branch_id: branchId,
        })
      ) as { id: string; email: string; expires_at: string }
      const { error } = await client.auth.signInWithOtp({
        email: data.email,
        options: { shouldCreateUser: true },
      })
      if (error) throw error
      return { id: data.id, email: data.email, expiresAt: data.expires_at }
    },

    async createStaff(email, password, name, roleId, branchId = null) {
      const data = unwrap(
        await client.rpc('create_staff_account', {
          p_organization_id: requireOrg(organizationId),
          p_email: email,
          p_password: password,
          p_name: name,
          p_role_id: roleId,
          p_branch_id: branchId,
        })
      ) as { user_id: string; email: string; created: boolean }
      return { id: data.user_id, email: data.email, created: data.created }
    },

    async removeStaff(userId) {
      unwrap(
        await client.rpc('remove_staff', {
          p_organization_id: requireOrg(organizationId),
          p_user_id: userId,
        })
      )
    },

    async listPermissions() {
      return unwrap(
        await client
          .from('permissions')
          .select('id,key,label,category')
          .is('plugin_key', null)
          .order('category')
          .order('key')
          .returns<{ id: string; key: string; label: string; category: string }[]>()
      )
    },

    async listRoles() {
      const orgId = requireOrg(organizationId)
      const roles = unwrap(
        await client
          .from('roles')
          .select('id,key,name,is_system')
          .eq('organization_id', orgId)
          .order('is_system', { ascending: false })
          .order('name')
          .returns<{ id: string; key: string; name: string; is_system: boolean }[]>()
      )
      if (roles.length === 0) return []
      const grants = unwrap(
        await client
          .from('role_permissions')
          .select('role_id,permissions(key)')
          .eq('organization_id', orgId)
          .in('role_id', roles.map((role) => role.id))
          .returns<{ role_id: string; permissions: { key: string } | { key: string }[] | null }[]>()
      )
      const permissionKeys = new Map<string, string[]>()
      for (const grant of grants) {
        const permission = Array.isArray(grant.permissions) ? grant.permissions[0] : grant.permissions
        if (permission) permissionKeys.set(grant.role_id, [...(permissionKeys.get(grant.role_id) ?? []), permission.key])
      }
      return roles.map(
        (role): RoleRow => ({
          id: role.id,
          key: role.key,
          name: role.name,
          isSystem: role.is_system,
          permissionKeys: permissionKeys.get(role.id) ?? [],
        })
      )
    },

    async createRole(name, key, permissionKeys) {
      const orgId = requireOrg(organizationId)
      const role = unwrap(
        await client
          .from('roles')
          .insert({ organization_id: orgId, name: name.trim(), key: key.trim().toLowerCase().replace(/\s+/g, '_'), is_system: false })
          .select('id,key,name,is_system')
          .single()
          .returns<{ id: string; key: string; name: string; is_system: boolean }>()
      )
      await replaceRolePermissions(client, orgId, role.id, permissionKeys)
      return { id: role.id, key: role.key, name: role.name, isSystem: role.is_system, permissionKeys: [...permissionKeys] }
    },

    async updateRole(id, name, permissionKeys) {
      const orgId = requireOrg(organizationId)
      const current = unwrap(
        await client
          .from('roles')
          .select('id,key,name,is_system')
          .eq('id', id)
          .eq('organization_id', orgId)
          .single()
          .returns<{ id: string; key: string; name: string; is_system: boolean }>()
      )
      const role = current.is_system
        ? current
        : unwrap(
            await client
              .from('roles')
              .update({ name: name.trim() })
              .eq('id', id)
              .eq('organization_id', orgId)
              .eq('is_system', false)
              .select('id,key,name,is_system')
              .single()
              .returns<{ id: string; key: string; name: string; is_system: boolean }>()
          )
      await replaceRolePermissions(client, orgId, role.id, permissionKeys)
      return { id: role.id, key: role.key, name: role.name, isSystem: role.is_system, permissionKeys: [...permissionKeys] }
    },

    async deleteRole(id) {
      const orgId = requireOrg(organizationId)
      const assignments = unwrap(
        await client.from('user_roles').select('id').eq('role_id', id).eq('organization_id', orgId).limit(1).returns<{ id: string }[]>()
      )
      if (assignments.length > 0) throw new Error('Remove this role from staff before deleting it.')
      const result = await client.from('roles').delete().eq('id', id).eq('organization_id', orgId).eq('is_system', false)
      if (result.error) throw result.error
    },

    async setStaffRoles(userId, roleIds, branchId = null) {
      unwrap(
        await client.rpc('set_staff_roles', {
          p_organization_id: requireOrg(organizationId),
          p_user_id: userId,
          p_role_ids: roleIds,
          p_branch_id: branchId,
        })
      )
    },
  }
}

// ── Stock (Phase 3) ───────────────────────────────────────────────────────

/** A row of the joined stock view, as PostgREST returns it (numeric = text). */
interface StockBalanceRow {
  quantity: string
  avg_unit_cost: string
  warehouse_id: string
  variant_id: string
  product_id: string
  updated_at: string
  warehouses: { name: string } | { name: string }[] | null
  product_variants:
    | { name_suffix: string | null; sku: string | null }
    | { name_suffix: string | null; sku: string | null }[]
    | null
  products:
    | { name: string; reorder_point: string; track_stock: boolean }
    | { name: string; reorder_point: string; track_stock: boolean }[]
    | null
}

interface MovementRowRaw {
  id: string
  created_at: string
  type: string
  direction: number
  quantity: string
  before_quantity: string
  after_quantity: string
  unit_cost: string
  warehouse_id: string
  warehouse_name: string
  variant_id: string
  product_name: string
  variant_name: string | null
  reference_type: string | null
  reference_id: string | null
  note: string | null
  user_id: string | null
}

/** PostgREST embeds a to-one join as an object, but the types say either. */
function embedded<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

function toStockRow(row: StockBalanceRow): StockRow {
  const variant = embedded(row.product_variants)
  const product = embedded(row.products)
  const warehouse = embedded(row.warehouses)
  const quantity = toMilli(row.quantity)
  const reorderPoint = toMilli(product?.reorder_point)
  const avgUnitCost = toMinor(row.avg_unit_cost)
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productName: product?.name ?? 'Unknown product',
    variantName: variant?.name_suffix ?? null,
    sku: variant?.sku ?? null,
    warehouseId: row.warehouse_id,
    warehouseName: warehouse?.name ?? '—',
    quantity,
    avgUnitCost,
    // Rounded to a minor unit once, here, so the screens agree with each
    // other and with `stock_summary` (which rounds the same way).
    stockValue: toMinor(Number(row.quantity) * Number(row.avg_unit_cost)),
    reorderPoint,
    trackStock: product?.track_stock ?? true,
    isLow: Boolean(product?.track_stock) && quantity > 0 && quantity <= reorderPoint,
    isOut: Boolean(product?.track_stock) && quantity <= 0,
    updatedAt: row.updated_at,
  }
}

/**
 * The stock overview for one branch, computed from its warehouses' balances.
 *
 * The organization-wide figures come from the `stock_summary` RPC; a branch is
 * a subset of warehouses the RPC does not take, so its numbers are derived here
 * from the same `stock_balances` rows and the same low/out/value rules as
 * `toStockRow`. That keeps the cards, the list and the badge in agreement
 * without a schema change (the RPC would need a branch parameter it does not
 * have). One extra head-count answers "movements today" for the branch.
 */
/** One balance row reduced to the numbers the summary counts. */
export interface BranchBalanceInput {
  quantity: number
  avgUnitCost: number
  reorderPoint: number
  trackStock: boolean
}

/**
 * The counting rules, pure and exported so the arithmetic is a tested fact
 * rather than something that only runs against a live database. These mirror
 * `toStockRow` exactly — low is "tracked, above zero, at or below reorder", out
 * is "tracked and at or below zero" — so the cards agree with the rows.
 */
export function summariseBranchBalances(rows: readonly BranchBalanceInput[]): {
  stockValueRaw: number
  variantsInStock: number
  lowStock: number
  outOfStock: number
} {
  let stockValueRaw = 0
  let variantsInStock = 0
  let lowStock = 0
  let outOfStock = 0
  for (const row of rows) {
    stockValueRaw += row.quantity * row.avgUnitCost
    if (row.quantity > 0) variantsInStock += 1
    if (row.trackStock && row.quantity > 0 && row.quantity <= row.reorderPoint) lowStock += 1
    if (row.trackStock && row.quantity <= 0) outOfStock += 1
  }
  return { stockValueRaw, variantsInStock, lowStock, outOfStock }
}

export interface OwingInput {
  total: number
  paidTotal: number
  /** The customer or supplier the debt belongs to; `null` for a walk-in. */
  partyId: string | null
}

/**
 * What is still owed, and by how many distinct parties, over a set of
 * invoices. Pure and exported so the branch dashboard's receivable and payable
 * are a tested fact rather than something that only runs against a live
 * database. A line owes money only when what it was billed exceeds what has
 * been paid; a party with several open bills is still one party.
 */
export function summariseOwing(rows: readonly OwingInput[]): {
  amountRaw: number
  parties: number
} {
  let amountRaw = 0
  const parties = new Set<string>()
  for (const row of rows) {
    const outstanding = row.total - row.paidTotal
    if (outstanding <= 0) continue
    amountRaw += outstanding
    if (row.partyId) parties.add(row.partyId)
  }
  return { amountRaw, parties: parties.size }
}

/** The live stock locations that make up a branch. */
async function branchWarehouseIds(client: SupabaseClient, branchId: string): Promise<string[]> {
  const rows = unwrap(
    await client
      .from('warehouses')
      .select('id')
      .eq('branch_id', branchId)
      .is('deleted_at', null)
      .returns<{ id: string }[]>()
  )
  return rows.map((row) => row.id)
}

/**
 * What this branch is owed and what it owes, from the branch's own invoices.
 *
 * The organization-wide dashboard reads `customers.balance` / `suppliers.balance`,
 * which have no branch dimension — a running khata total that a multi-branch shop
 * cannot attribute to the branch on screen. So the branch figures are derived
 * from the transactions that carry `branch_id`: an unpaid customer invoice
 * (`PARTIALLY_PAID`, the status the khata itself treats as an open bill) and an
 * unpaid supplier purchase (ordered, received or partly received).
 */
async function branchOwing(
  client: SupabaseClient,
  branchId: string
): Promise<{
  receivable: { amount: Minor; parties: number }
  payable: { amount: Minor; parties: number }
}> {
  const [salesRes, purchasesRes] = await Promise.all([
    client
      .from('sales')
      .select('total,paid_total,customer_id')
      .eq('branch_id', branchId)
      .eq('status', 'PARTIALLY_PAID')
      .returns<{ total: string; paid_total: string; customer_id: string | null }[]>(),
    client
      .from('purchases')
      .select('total,paid_total,supplier_id')
      .eq('branch_id', branchId)
      .in('status', ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'])
      .returns<{ total: string; paid_total: string; supplier_id: string | null }[]>(),
  ])
  const receivable = summariseOwing(
    unwrap(salesRes).map((row) => ({
      total: Number(row.total),
      paidTotal: Number(row.paid_total),
      partyId: row.customer_id,
    }))
  )
  const payable = summariseOwing(
    unwrap(purchasesRes).map((row) => ({
      total: Number(row.total),
      paidTotal: Number(row.paid_total),
      partyId: row.supplier_id,
    }))
  )
  return {
    receivable: { amount: toMinor(receivable.amountRaw), parties: receivable.parties },
    payable: { amount: toMinor(payable.amountRaw), parties: payable.parties },
  }
}

async function branchStockSummary(
  client: SupabaseClient,
  warehouseIds: readonly string[]
): Promise<StockSummary> {
  type Row = {
    quantity: string
    avg_unit_cost: string
    products:
      | { reorder_point: string; track_stock: boolean }
      | { reorder_point: string; track_stock: boolean }[]
      | null
  }
  const rows = unwrap(
    await client
      .from('stock_balances')
      .select('quantity,avg_unit_cost,products(reorder_point,track_stock)')
      .in('warehouse_id', warehouseIds as string[])
      .returns<Row[]>()
  )

  const totals = summariseBranchBalances(
    rows.map((row) => {
      const product = embedded(row.products)
      return {
        quantity: Number(row.quantity),
        avgUnitCost: Number(row.avg_unit_cost),
        reorderPoint: Number(product?.reorder_point ?? 0),
        trackStock: product?.track_stock ?? true,
      }
    })
  )

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const { count } = await client
    .from('stock_history')
    .select('id', { count: 'exact', head: true })
    .in('warehouse_id', warehouseIds as string[])
    .gte('created_at', startOfToday.toISOString())

  return {
    stockValue: toMinor(totals.stockValueRaw),
    variantsInStock: totals.variantsInStock,
    lowStock: totals.lowStock,
    outOfStock: totals.outOfStock,
    warehouses: warehouseIds.length,
    movementsToday: count ?? 0,
  }
}

function toMovementRow(row: MovementRowRaw): StockMovementRow {
  const quantity = toMilli(row.quantity)
  const direction: 1 | -1 = row.direction < 0 ? -1 : 1
  return {
    id: row.id,
    createdAt: row.created_at,
    type: row.type,
    direction,
    quantity,
    delta: toMilli(Number(row.quantity) * direction),
    beforeQuantity: toMilli(row.before_quantity),
    afterQuantity: toMilli(row.after_quantity),
    // Displayed, not multiplied: rounding to a minor unit here is what the
    // screen shows anyway, and the exact figure stays in the ledger.
    unitCost: toMinor(row.unit_cost),
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    variantId: row.variant_id,
    productName: row.product_name,
    variantName: row.variant_name,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    note: row.note,
    userId: row.user_id,
  }
}

const STOCK_SELECT = [
  'quantity',
  'avg_unit_cost',
  'warehouse_id',
  'variant_id',
  'product_id',
  'updated_at',
  'warehouses(name)',
  'product_variants(name_suffix,sku)',
  'products(name,reorder_point,track_stock)',
].join(',')

const MOVEMENT_SELECT = [
  'id',
  'created_at',
  'type',
  'direction',
  'quantity',
  'before_quantity',
  'after_quantity',
  'unit_cost',
  'warehouse_id',
  'warehouse_name',
  'variant_id',
  'product_name',
  'variant_name',
  'reference_type',
  'reference_id',
  'note',
  'user_id',
].join(',')

function createStock(
  client: SupabaseClient,
  organizationId: () => string | null
): StockRepository {
  return {
    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('stock_balances')
        .select(STOCK_SELECT)
        .order('updated_at', { ascending: false })
        .order('variant_id', { ascending: false })
        .limit(limit)

      builder = stockAfterCursor(builder, query.cursor)

      // An explicit dropdown choice is exact; otherwise a branch confines the
      // list to its own stock locations. `.in([])` would match nothing, so an
      // empty set is treated as "no branch filter" rather than "hide all".
      if (query.warehouseId) builder = builder.eq('warehouse_id', query.warehouseId)
      else if (query.warehouseIds && query.warehouseIds.length > 0)
        builder = builder.in('warehouse_id', query.warehouseIds)

      const rows = unwrap(await builder.returns<StockBalanceRow[]>())
      let items = rows.map(toStockRow)

      // Search, the low/out filters and the "worth showing at all" rule are
      // applied after the join, because they depend on the product rows and on
      // arithmetic across two of them. The alternative — filtering in SQL —
      // would need a view, and the visible set is a page of 25, so the cost is
      // bounded and the code stays in one place.
      const search = query.search?.trim().toLowerCase()
      if (search) {
        items = items.filter(
          (row) =>
            row.productName.toLowerCase().includes(search) ||
            (row.variantName ?? '').toLowerCase().includes(search) ||
            (row.sku ?? '').toLowerCase().includes(search)
        )
      }
      if (query.filter === 'low') items = items.filter((row) => row.isLow)
      if (query.filter === 'out') items = items.filter((row) => row.isOut)

      return { items, nextCursor: stockNextCursor(rows, limit) }
    },

    async history(variantId, query) {
      const limit = clampLimit(query.limit, 50)
      let builder = client
        .from('stock_history')
        .select(MOVEMENT_SELECT)
        .eq('variant_id', variantId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)
      if (query.warehouseId) builder = builder.eq('warehouse_id', query.warehouseId)
      else if (query.warehouseIds && query.warehouseIds.length > 0)
        builder = builder.in('warehouse_id', query.warehouseIds)

      const rows = unwrap(await builder.returns<MovementRowRaw[]>())
      return { items: rows.map(toMovementRow), nextCursor: paginate(rows, limit).nextCursor }
    },

    async recent(query) {
      const limit = clampLimit(query.limit, 15)
      let builder = client
        .from('stock_history')
        .select(MOVEMENT_SELECT)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)
      if (query.warehouseId) builder = builder.eq('warehouse_id', query.warehouseId)
      else if (query.warehouseIds && query.warehouseIds.length > 0)
        builder = builder.in('warehouse_id', query.warehouseIds)

      const rows = unwrap(await builder.returns<MovementRowRaw[]>())
      return { items: rows.map(toMovementRow), nextCursor: paginate(rows, limit).nextCursor }
    },

    async summary(scope) {
      // A branch is a set of stock locations. When the caller names them the
      // six figures are computed for that branch alone, from the same tables
      // and the same rounding the stock list uses — so the cards, the rows and
      // the badge all agree. With no scope the organization-wide RPC answers,
      // which is the ambient badge's original behaviour.
      const warehouseIds = scope?.warehouseIds
      if (warehouseIds && warehouseIds.length > 0) {
        return branchStockSummary(client, warehouseIds)
      }

      const raw = unwrap(
        await client.rpc('stock_summary', { p_organization_id: requireOrg(organizationId) })
      ) as {
        stock_value: string
        variants_in_stock: number
        low_stock: number
        out_of_stock: number
        warehouses: number
        movements_today: number
      }
      return {
        stockValue: toMinor(raw.stock_value),
        variantsInStock: Number(raw.variants_in_stock),
        lowStock: Number(raw.low_stock),
        outOfStock: Number(raw.out_of_stock),
        warehouses: Number(raw.warehouses),
        movementsToday: Number(raw.movements_today),
      }
    },

    async listWarehouses(branchId) {
      let builder = client
        .from('warehouses')
        .select('id,name,is_retail_floor')
        .is('deleted_at', null)
      if (branchId) builder = builder.eq('branch_id', branchId)
      const rows = unwrap(
        await builder
          .order('is_retail_floor', { ascending: false })
          .order('name')
          .returns<{ id: string; name: string; is_retail_floor: boolean }[]>()
      )
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        isRetailFloor: row.is_retail_floor,
      })) satisfies WarehouseOption[]
    },

    async stockIn(warehouseId, lines, options) {
      const result = unwrap(
        await client.rpc('stock_in', {
          p_warehouse_id: warehouseId,
          // Quantities and costs go back as plain numbers: PostgREST casts
          // them into numeric(14,3) / numeric(14,4), and the branded types
          // exist to stop accidental arithmetic, not to reach the wire.
          p_items: lines.map((line) => ({
            variant_id: line.variantId,
            qty: milliToNumber(line.qty),
            ...(line.unitCost === undefined ? {} : { unit_cost: minorToNumber(line.unitCost) }),
          })),
          p_supplier_id: options?.supplierId ?? null,
          p_reference: options?.reference ?? null,
          p_note: options?.note ?? null,
        })
      ) as { line_count: number; total_qty: string; total_cost: string }
      return {
        lineCount: Number(result.line_count),
        totalQty: toMilli(result.total_qty),
        totalCost: toMinor(result.total_cost),
      } satisfies StockOperationResult
    },

    async stockOut(warehouseId, lines, reason, note) {
      const result = unwrap(
        await client.rpc('stock_out', {
          p_warehouse_id: warehouseId,
          p_items: lines.map((line) => ({
            variant_id: line.variantId,
            qty: milliToNumber(line.qty),
          })),
          p_reason: reason,
          p_note: note ?? null,
        })
      ) as { line_count: number; total_qty: string }
      return {
        lineCount: Number(result.line_count),
        totalQty: toMilli(result.total_qty),
      } satisfies StockOperationResult
    },

    async transfer(fromWarehouseId, toWarehouseId, lines, note) {
      const transferId = unwrap(
        await client.rpc('transfer_stock', {
          p_from_warehouse_id: fromWarehouseId,
          p_to_warehouse_id: toWarehouseId,
          p_items: lines.map((line) => ({
            variant_id: line.variantId,
            qty: milliToNumber(line.qty),
          })),
          p_note: note ?? null,
        })
      ) as string
      const totalQty = lines.reduce((sum, line) => sum + milliToNumber(line.qty), 0)
      return {
        lineCount: lines.length,
        totalQty: milli(totalQty),
        transferId,
      } satisfies StockOperationResult
    },

    async adjust(warehouseId, variantId, qty, reason, direction, note) {
      unwrap(
        await client.rpc('adjust_stock', {
          p_warehouse_id: warehouseId,
          p_variant_id: variantId,
          p_quantity: milliToNumber(qty),
          p_reason: reason,
          p_direction: direction,
          p_note: note ?? null,
        })
      )
    },

    async setReorderPoint(productId, reorderPoint) {
      const rows = unwrap(
        await client
          .from('products')
          .update({ reorder_point: milliToNumber(reorderPoint) })
          .eq('id', productId)
          .select('id')
          .returns<{ id: string }[]>()
      )
      if (rows.length === 0) throw new Error('Product not found, or you cannot edit it.')
    },
  }
}

// ── Suppliers (Phase 4) ───────────────────────────────────────────────────

interface SupplierRaw {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  note: string | null
  balance: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

const SUPPLIER_SELECT = 'id,name,phone,email,address,note,balance,metadata,created_at,updated_at'

function toSupplier(row: SupplierRaw): SupplierRow {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    note: row.note,
    // Positive means the shop owes them.
    balance: toMinor(row.balance),
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function createSuppliers(
  client: SupabaseClient,
  organizationId: () => string | null
): SupplierRepository {
  return {
    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('suppliers')
        .select(SUPPLIER_SELECT)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)

      const search = query.search?.trim()
      if (search) {
        // Name, phone or email: a shopkeeper looking for "Karim" and one
        // looking for the number on the invoice are the same gesture.
        builder = builder.or(
          `name.ilike.%${likeTerm(search)}%,phone.ilike.%${likeTerm(search)}%,email.ilike.%${likeTerm(search)}%`
        )
      }

      const rows = unwrap(await builder.returns<SupplierRaw[]>())
      return { items: rows.map(toSupplier), nextCursor: paginate(rows, limit).nextCursor }
    },

    async get(id) {
      const rows = unwrap(
        await client.from('suppliers').select(SUPPLIER_SELECT).eq('id', id).limit(1).returns<SupplierRaw[]>()
      )
      return rows[0] ? toSupplier(rows[0]) : null
    },

    async create(draft) {
      const rows = unwrap(
        await client
          .from('suppliers')
          .insert({
            organization_id: requireOrg(organizationId),
            name: draft.name.trim(),
            phone: draft.phone?.trim() || null,
            email: draft.email?.trim() || null,
            address: draft.address?.trim() || null,
            note: draft.note?.trim() || null,
            ...(draft.metadata !== undefined ? { metadata: draft.metadata } : {}),
          })
          .select(SUPPLIER_SELECT)
          .returns<SupplierRaw[]>()
      )
      const row = rows[0]
      if (!row) throw new Error('The supplier could not be created.')
      return toSupplier(row)
    },

    async update(id, draft) {
      const patch: Record<string, unknown> = {}
      if (draft.name !== undefined) patch.name = draft.name.trim()
      if (draft.phone !== undefined) patch.phone = draft.phone?.trim() || null
      if (draft.email !== undefined) patch.email = draft.email?.trim() || null
      if (draft.address !== undefined) patch.address = draft.address?.trim() || null
      if (draft.note !== undefined) patch.note = draft.note?.trim() || null
      if (draft.metadata !== undefined) patch.metadata = draft.metadata

      const rows = unwrap(
        await client.from('suppliers').update(patch).eq('id', id).select(SUPPLIER_SELECT).returns<SupplierRaw[]>()
      )
      const row = rows[0]
      if (!row) throw new Error('Supplier not found, or you cannot edit it.')
      return toSupplier(row)
    },

    async purchases(supplierId, query = {}) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('purchases')
        .select(PURCHASE_SELECT)
        .eq('supplier_id', supplierId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)
      builder = afterCursor(builder, query.cursor)
      const rows = unwrap(await builder.returns<PurchaseRaw[]>())
      return { items: rows.map(toPurchase), nextCursor: paginate(rows, limit).nextCursor }
    },
  }
}

// ── Purchases (Phase 4) ───────────────────────────────────────────────────

interface PurchaseRaw {
  id: string
  invoice_no: string
  reference_no: string | null
  status: PurchaseRow['status']
  supplier_id: string | null
  warehouse_id: string
  subtotal: string
  tax_total: string
  total: string
  paid_total: string
  note: string | null
  expected_at: string | null
  created_at: string
  received_at: string | null
  suppliers: { name: string } | { name: string }[] | null
  warehouses: { name: string } | { name: string }[] | null
}

const PURCHASE_SELECT = [
  'id',
  'invoice_no',
  'reference_no',
  'status',
  'supplier_id',
  'warehouse_id',
  'subtotal',
  'tax_total',
  'total',
  'paid_total',
  'note',
  'expected_at',
  'created_at',
  'received_at',
  'suppliers(name)',
  'warehouses(name)',
].join(',')

function toPurchase(row: PurchaseRaw): PurchaseRow {
  const total = toMinor(row.total)
  const paidTotal = toMinor(row.paid_total)
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    referenceNo: row.reference_no,
    status: row.status,
    supplierId: row.supplier_id,
    supplierName: embedded(row.suppliers)?.name ?? null,
    warehouseId: row.warehouse_id,
    warehouseName: embedded(row.warehouses)?.name ?? null,
    subtotal: toMinor(row.subtotal),
    taxTotal: toMinor(row.tax_total),
    total,
    paidTotal,
    // total and paidTotal are already minor units — subtract them directly.
    // Passing them through minorToNumber first descaled the result by 100
    // (₹24,500.00 showed as ₹245.00 due on the purchase order).
    outstanding: minor(total - paidTotal),
    note: row.note,
    expectedAt: asDate(row.expected_at),
    createdAt: row.created_at,
    receivedAt: row.received_at,
  } satisfies PurchaseRow
}

function createPurchases(client: SupabaseClient): PurchaseRepository {
  return {
    async searchProducts(warehouseId, search, limit = 20) {
      const rows = unwrap(
        await client.rpc('purchase_products', {
          p_warehouse_id: warehouseId,
          p_search: search.trim() || null,
          p_limit: Math.min(Math.max(limit, 1), 100),
        })
      ) as PosCatalogRow[]
      return rows.map(toSellable)
    },

    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('purchases')
        .select(PURCHASE_SELECT)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)
      // Purchases are received into a branch's warehouse and the table carries
      // `branch_id`, so the list is scoped to the till's branch when asked.
      if (query.branchId) builder = builder.eq('branch_id', query.branchId)
      if (query.status) builder = builder.eq('status', query.status)
      if (query.supplierId) builder = builder.eq('supplier_id', query.supplierId)

      const search = query.search?.trim()
      if (search) {
        builder = builder.or(
          `invoice_no.ilike.%${likeTerm(search)}%,reference_no.ilike.%${likeTerm(search)}%`
        )
      }

      const rows = unwrap(await builder.returns<PurchaseRaw[]>())
      return { items: rows.map(toPurchase), nextCursor: paginate(rows, limit).nextCursor }
    },

    async get(id) {
      const rows = unwrap(
        await client.from('purchases').select(PURCHASE_SELECT).eq('id', id).limit(1).returns<PurchaseRaw[]>()
      )
      const row = rows[0]
      if (!row) return null

      const items = unwrap(
        await client
          .from('purchase_items')
          .select(
            'id,variant_id,product_name,quantity,received_qty,unit_cost,line_total,product_variants(name_suffix)'
          )
          .eq('purchase_id', id)
          .order('product_name')
          .returns<
            {
              id: string
              variant_id: string
              product_name: string
              quantity: string
              received_qty: string
              unit_cost: string
              line_total: string
              product_variants: { name_suffix: string | null } | { name_suffix: string | null }[] | null
            }[]
          >()
      )

      const payments = unwrap(
        await client
          .from('purchase_payments')
          .select('id,amount,method_id,reference,paid_at,payment_methods(name)')
          .eq('purchase_id', id)
          .order('paid_at', { ascending: false })
          .returns<
            {
              id: string
              amount: string
              method_id: string
              reference: string | null
              paid_at: string
              payment_methods: { name: string } | { name: string }[] | null
            }[]
          >()
      )

      const detail: PurchaseDetail = {
        purchase: toPurchase(row),
        items: items.map((item) => {
          const quantity = toMilli(item.quantity)
          const receivedQty = toMilli(item.received_qty)
          return {
            id: item.id,
            variantId: item.variant_id,
            productName: item.product_name,
            variantName: embedded(item.product_variants)?.name_suffix ?? null,
            quantity,
            receivedQty,
            // What is still to come — the number the receiving dialog defaults to.
            // quantity and receivedQty are already milli units; subtract them
            // directly. milliToNumber first descaled it by 1000 (10 units of 10
            // outstanding prefilled the receive dialog as 0.01).
            outstanding: milli(quantity - receivedQty),
            unitCost: toMinor(item.unit_cost),
            lineTotal: toMinor(item.line_total),
          }
        }),
        payments: payments.map(
          (payment): PurchasePaymentRow => ({
            id: payment.id,
            amount: toMinor(payment.amount),
            methodId: payment.method_id,
            methodName: embedded(payment.payment_methods)?.name ?? null,
            reference: payment.reference,
            paidAt: payment.paid_at,
          })
        ),
      }
      return detail
    },

    async save(input) {
      const id = unwrap(
        await client.rpc('save_purchase', {
          p_warehouse_id: input.warehouseId,
          p_items: input.lines.map((line) => ({
            variant_id: line.variantId,
            qty: milliToNumber(line.qty),
            unit_cost: minorToNumber(line.unitCost),
            tax_rate: line.taxRate ?? 0,
          })),
          p_supplier_id: input.supplierId,
          p_purchase_id: input.id ?? null,
          p_status: input.status,
          p_reference_no: input.referenceNo ?? null,
          p_note: input.note ?? null,
          p_expected_at: input.expectedAt ?? null,
        })
      ) as string
      return id
    },

    async receive(id, lines, payments) {
      const result = unwrap(
        await client.rpc('receive_purchase', {
          p_purchase_id: id,
          p_items: lines.map((line) => ({
            purchase_item_id: line.purchaseItemId,
            qty: milliToNumber(line.qty),
            ...(line.unitCost === undefined ? {} : { unit_cost: minorToNumber(line.unitCost) }),
          })),
          p_paid: payments.map((payment) => ({
            method_id: payment.methodId,
            amount: minorToNumber(payment.amount),
            reference: payment.reference ?? null,
          })),
        })
      ) as { status: string; received_value: string; paid: string }
      return {
        status: result.status,
        receivedValue: toMinor(result.received_value),
        paid: toMinor(result.paid),
      }
    },

    async cancel(id, reason) {
      const result = unwrap(
        await client.rpc('cancel_purchase', { p_purchase_id: id, p_reason: reason ?? null })
      ) as { released: string }
      return { released: toMinor(result.released) }
    },

    async pay(input) {
      const result = unwrap(
        await client.rpc('apply_payment', {
          p_supplier_id: input.supplierId,
          p_amount: minorToNumber(input.amount),
          p_method_id: input.methodId,
          p_purchase_id: input.purchaseId ?? null,
          p_reference: input.reference ?? null,
          p_note: null,
        })
      ) as { supplier_balance: string }
      return { supplierBalance: toMinor(result.supplier_balance) }
    },
  }
}

// ── Expenses (Phase 4) ────────────────────────────────────────────────────

interface ExpenseRaw {
  id: string
  expense_date: string
  amount: string
  category_id: string | null
  method_id: string | null
  description: string | null
  attachment_url: string | null
  session_id: string | null
  created_at: string
  expense_categories: { name: string } | { name: string }[] | null
  payment_methods: { name: string; is_cash: boolean } | { name: string; is_cash: boolean }[] | null
}

const EXPENSE_SELECT =
  'id,expense_date,amount,category_id,method_id,description,attachment_url,session_id,created_at,' +
  'expense_categories(name),payment_methods(name,is_cash)'

function toExpense(row: ExpenseRaw): ExpenseRow {
  const method = embedded(row.payment_methods)
  return {
    id: row.id,
    expenseDate: asDate(row.expense_date) ?? '',
    amount: toMinor(row.amount),
    categoryId: row.category_id,
    categoryName: embedded(row.expense_categories)?.name ?? null,
    methodId: row.method_id,
    methodName: method?.name ?? null,
    isCash: method?.is_cash ?? false,
    description: row.description,
    attachmentUrl: row.attachment_url,
    sessionId: row.session_id,
    createdAt: row.created_at,
  }
}

function createExpenses(
  client: SupabaseClient,
  organizationId: () => string | null
): ExpenseRepository {
  return {
    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('expenses')
        .select(EXPENSE_SELECT)
        .is('deleted_at', null)
        .order('expense_date', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      builder = afterCursor(builder, query.cursor)
      if (query.from) builder = builder.gte('expense_date', query.from)
      if (query.to) builder = builder.lte('expense_date', query.to)
      if (query.categoryId) builder = builder.eq('category_id', query.categoryId)

      const search = query.search?.trim()
      if (search) builder = builder.ilike('description', `%${likeTerm(search)}%`)

      const rows = unwrap(await builder.returns<ExpenseRaw[]>())
      return { items: rows.map(toExpense), nextCursor: paginate(rows, limit).nextCursor }
    },

    async totalForDay(date) {
      const rows = unwrap(
        await client
          .from('expenses')
          .select('amount')
          .is('deleted_at', null)
          .eq('expense_date', date)
          .returns<{ amount: string }[]>()
      )
      // Summed in minor units so the total is exact: adding floats and
      // rounding at the end drifts by a paisa on a long expense list.
      return toMinor(rows.reduce((sum, row) => sum + Number(row.amount), 0))
    },

    async create(input) {
      // Through the RPC, not an insert: recording an expense is what moves the
      // register's cash figure, and that has to happen in the same transaction.
      const id = unwrap(
        await client.rpc('record_expense', {
          p_branch_id: input.branchId,
          p_amount: minorToNumber(input.amount),
          p_category_id: input.categoryId ?? null,
          p_method_id: input.methodId ?? null,
          p_description: input.description ?? null,
          p_session_id: input.sessionId ?? null,
          p_expense_date: input.expenseDate ?? null,
        })
      ) as string
      return id
    },

    async update(id, patch) {
      const body: Record<string, unknown> = {}
      if (patch.amount !== undefined) body.amount = minorToNumber(patch.amount)
      if (patch.categoryId !== undefined) body.category_id = patch.categoryId
      if (patch.description !== undefined) body.description = patch.description
      const rows = unwrap(
        await client.from('expenses').update(body).eq('id', id).select('id').returns<{ id: string }[]>()
      )
      if (rows.length === 0) throw new Error('Expense not found, or you cannot edit it.')
    },

    async remove(id) {
      // Soft delete. A hard delete would silently change a closed session's
      // expected cash, leaving a reconciled drawer permanently unexplained.
      const rows = unwrap(
        await client
          .from('expenses')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', id)
          .select('id')
          .returns<{ id: string }[]>()
      )
      if (rows.length === 0) throw new Error('Expense not found, or you cannot delete it.')
    },

    async categories() {
      const rows = unwrap(
        await client
          .from('expense_categories')
          .select('id,name,is_system')
          .order('is_system', { ascending: false })
          .order('name')
          .returns<{ id: string; name: string; is_system: boolean }[]>()
      )
      return rows.map((row) => ({ id: row.id, name: row.name, isSystem: row.is_system }))
    },

    async createCategory(name) {
      const rows = unwrap(
        await client
          .from('expense_categories')
          .insert({ organization_id: requireOrg(organizationId), name: name.trim() })
          .select('id,name,is_system')
          .returns<{ id: string; name: string; is_system: boolean }[]>()
      )
      const row = rows[0]
      if (!row) throw new Error('The category could not be created.')
      return { id: row.id, name: row.name, isSystem: row.is_system }
    },

    async removeCategory(id) {
      const rows = unwrap(
        await client.from('expense_categories').delete().eq('id', id).select('id').returns<{ id: string }[]>()
      )
      if (rows.length === 0) {
        throw new Error('Category not found — categories in use by an expense cannot be removed.')
      }
    },
  }
}

// ── Returns (Phase 4) ─────────────────────────────────────────────────────

function createReturns(client: SupabaseClient): ReturnsRepository {
  return {
    async refund(input) {
      const result = unwrap(
        await client.rpc('refund_sale', {
          p_sale_id: input.saleId,
          p_items: input.lines.map((line) => ({
            sale_item_id: line.saleItemId,
            qty: milliToNumber(line.qty),
          })),
          p_payments: input.payments.map((payment) => ({
            method_id: payment.methodId,
            amount: minorToNumber(payment.amount),
            reference: payment.reference ?? null,
          })),
          p_reason: input.reason ?? null,
          p_restock: input.restock ?? true,
        })
      ) as { return_id: string; refund_total: string; sale_status: string }
      return {
        returnId: result.return_id,
        refundTotal: toMinor(result.refund_total),
        saleStatus: result.sale_status,
      } satisfies RefundResult
    },

    async refundToCredit(input) {
      const result = unwrap(
        await client.rpc('refund_sale_to_credit', {
          p_sale_id: input.saleId,
          p_items: input.lines.map((line) => ({
            sale_item_id: line.saleItemId,
            qty: milliToNumber(line.qty),
          })),
          p_reason: input.reason ?? null,
          p_restock: input.restock ?? true,
        })
      ) as { return_id: string; refund_total: string; sale_status: string; store_credit: string }
      return {
        returnId: result.return_id,
        refundTotal: toMinor(result.refund_total),
        saleStatus: result.sale_status,
        storeCredit: toMinor(result.store_credit),
      } satisfies RefundResult
    },
  }
}

// ── Audit trail (Phase 4) ─────────────────────────────────────────────────

interface AuditRaw {
  id: number | string
  created_at: string
  action: AuditEntry['action']
  entity_type: string
  entity_id: string | null
  actor_id: string | null
  actor_email: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

function createAudit(client: SupabaseClient): AuditRepository {
  return {
    async list(query) {
      const limit = clampLimit(query.limit, 25)
      let builder = client
        .from('audit_trail')
        .select('id,created_at,action,entity_type,entity_id,actor_id,actor_email,before,after')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      // The cursor helper keys on a uuid id; audit ids are bigints, so the
      // comparison is built here rather than reused.
      if (query.cursor) {
        const decoded = decodeCursor(query.cursor)
        if (decoded) {
          builder = builder.or(
            `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`
          )
        }
      }

      if (query.entityType) builder = builder.eq('entity_type', query.entityType)
      if (query.actorId) builder = builder.eq('actor_id', query.actorId)
      if (query.action) builder = builder.eq('action', query.action)
      if (query.entityId) builder = builder.eq('entity_id', query.entityId)
      if (query.search) builder = builder.ilike('entity_type', `%${likeTerm(query.search)}%`)

      const rows = unwrap(await builder.returns<AuditRaw[]>())
      const items = rows.map(
        (row): AuditEntry => ({
          id: String(row.id),
          createdAt: row.created_at,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          actorId: row.actor_id,
          actorEmail: row.actor_email,
          before: row.before,
          after: row.after,
        })
      )
      const last = rows[rows.length - 1]
      const nextCursor =
        rows.length === limit && last ? encodeCursor(last.created_at, String(last.id)) : null
      return { items, nextCursor }
    },

    async entityTypes() {
      const rows = unwrap(
        await client
          .from('audit_trail')
          .select('entity_type')
          .limit(1000)
          .returns<{ entity_type: string }[]>()
      )
      return [...new Set(rows.map((row) => row.entity_type))].sort()
    },
  }
}

// ── Analytics and reporting (Phase 5) ─────────────────────────────────────
//
// Both RPCs return one jsonb document; the conversion below turns it into the
// contract types. Two rules it keeps:
//
//   * money arrives as minor units. The server sends `numeric`, which crosses
//     PostgREST as a string, so every money field is converted here and never
//     by a screen.
//   * a slice knows whether its own measure is money (`money`), because the
//     repository cannot: "Takings by day" and "Orders by day" are the same
//     shape with different units, and guessing from the numbers is how a
//     count ends up rendered as ৳0.42.

interface RawPoint {
  key?: unknown
  label?: unknown
  value?: unknown
  secondary?: unknown
  prev?: unknown
  prev_secondary?: unknown
}

interface RawSlice {
  dimension?: unknown
  measure?: unknown
  period?: unknown
  label?: unknown
  timezone?: unknown
  currency?: unknown
  from?: unknown
  to?: unknown
  previous?: { from?: unknown; to?: unknown } | null
  series?: unknown
  totals?: Record<string, unknown> | null
  answers?: unknown
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toPoints(raw: unknown, money: boolean): AnalyticsPoint[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const point = (entry ?? {}) as RawPoint
    // Money stays in minor units end to end: the RPC sends `numeric`, this
    // converts once, and nothing downstream ever multiplies by 100 again.
    const scale = (value: unknown): number =>
      money ? (toMinor(value as string) as number) : num(value)
    return {
      key: str(point.key),
      label: str(point.label),
      value: scale(point.value),
      secondary: scale(point.secondary),
      prev: scale(point.prev),
      prevSecondary: scale(point.prev_secondary),
    }
  })
}

function toAnswers(raw: unknown): BiAnswer[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>
    const kind = str(item.kind, 'text')
    const resolved = (kind === 'money' || kind === 'count' || kind === 'qty' ? kind : 'text') as BiAnswer['kind']
    const raw = str(item.value)
    return {
      id: str(item.id),
      question: str(item.question),
      kind: resolved,
      value: raw,
      // Parsed here, once: a screen that did `Number(answer.value)` would be
      // re-deriving money in the UI layer.
      amount: resolved === 'money' && raw !== '' ? toMinor(raw) : null,
      count: resolved === 'count' || resolved === 'qty' ? num(raw) : null,
      note: str(item.note),
      link: str(item.link),
      icon: str(item.icon, 'insights'),
    }
  })
}

function toSlice(raw: RawSlice, money: boolean): AnalyticsSlice {
  const totals = raw.totals ?? null
  const scale = (value: unknown): number =>
    value === null || value === undefined ? 0 : money ? (toMinor(value as string) as number) : num(value)

  const analyticsTotals: AnalyticsTotals | null = totals
    ? {
        value: scale(totals.value),
        secondary: scale(totals.secondary),
        prev: totals.prev === null || totals.prev === undefined ? null : scale(totals.prev),
        prevSecondary:
          totals.prev_secondary === null || totals.prev_secondary === undefined
            ? null
            : scale(totals.prev_secondary),
        deltaPct: totals.delta_pct === null || totals.delta_pct === undefined ? null : num(totals.delta_pct),
      }
    : null

  return {
    dimension: str(raw.dimension),
    measure: str(raw.measure),
    period: str(raw.period),
    money,
    label: str(raw.label),
    timezone: str(raw.timezone, 'UTC'),
    currency: str(raw.currency, 'BDT'),
    from: str(raw.from),
    to: str(raw.to),
    previousFrom: str(raw.previous?.from),
    previousTo: str(raw.previous?.to),
    series: toPoints(raw.series, money),
    totals: analyticsTotals,
    answers: toAnswers(raw.answers),
  }
}

/** Which measures are money, from the catalogue the server owns. */
function moneyMeasures(catalog: AnalyticsCatalog): Set<string> {
  return new Set(catalog.measures.filter((measure) => measure.money).map((measure) => measure.id))
}

function createAnalytics(client: SupabaseClient): AnalyticsRepository {
  /** Cached for the session: the catalogue is part of the schema, not the data. */
  let catalogCache: AnalyticsCatalog | null = null

  async function catalog(): Promise<AnalyticsCatalog> {
    if (catalogCache) return catalogCache
    const data = unwrap(await client.rpc('analytics_catalog'))
    const raw = (data ?? {}) as Record<string, unknown>
    const parsed: AnalyticsCatalog = {
      measures: Array.isArray(raw.measures)
        ? raw.measures.map((entry) => {
            const measure = (entry ?? {}) as Record<string, unknown>
            return {
              id: str(measure.id),
              label: str(measure.label),
              money: measure.money === true,
              unit: str(measure.unit, 'money'),
              description: str(measure.description),
            }
          })
        : [],
      dimensions: Array.isArray(raw.dimensions)
        ? raw.dimensions.map((entry) => {
            const dimension = (entry ?? {}) as Record<string, unknown>
            return {
              id: str(dimension.id),
              label: str(dimension.label),
              group: str(dimension.group, 'Other'),
              kind: str(dimension.kind, 'entity') === 'time' ? ('time' as const) : ('entity' as const),
            }
          })
        : [],
      periods: Array.isArray(raw.periods)
        ? raw.periods.map((entry) => {
            const period = (entry ?? {}) as Record<string, unknown>
            return { id: str(period.id), label: str(period.label) }
          })
        : [],
      combos: Array.isArray(raw.combos)
        ? raw.combos.map((entry) => {
            const combo = (entry ?? {}) as Record<string, unknown>
            return { measure: str(combo.measure), dimension: str(combo.dimension) }
          })
        : [],
    }
    catalogCache = parsed
    return parsed
  }

  return {
    catalog,

    async dashboard({ branchId, day }): Promise<DashboardSummary> {
      const data = unwrap(
        await client.rpc('dashboard_summary', { p_branch_id: branchId, p_day: day ?? null })
      )
      const raw = (data ?? {}) as Record<string, unknown>
      // No catalogue call here: the trend and ranking slots this function
      // reads are always money measures, and asking the server what it had
      // already told us would turn the dashboard's one round trip into two.
      // (The analytics screen still reads the catalogue, where the pickers
      // genuinely need it.)

      const salesByHour = Array.isArray(raw.sales_by_hour)
        ? raw.sales_by_hour.map((entry) => {
            const row = (entry ?? {}) as Record<string, unknown>
            return { hour: num(row.hour), total: toMinor(row.total as string) }
          })
        : []
      const paymentMix = Array.isArray(raw.payment_mix)
        ? raw.payment_mix.map((entry) => {
            const row = (entry ?? {}) as Record<string, unknown>
            return { method: str(row.method), total: toMinor(row.total as string) }
          })
        : []
      const topProducts = Array.isArray(raw.top_products)
        ? raw.top_products.map((entry) => {
            const row = (entry ?? {}) as Record<string, unknown>
            return { name: str(row.name), qty: num(row.qty), revenue: toMinor(row.revenue as string) }
          })
        : []

      const daySlice = toSlice((raw.trend_days ?? {}) as RawSlice, true)
      const profitSlice = toSlice((raw.trend_profit ?? {}) as RawSlice, true)

      const base: DashboardSummary = {
        date: str(raw.date),
        timezone: str(raw.timezone, 'UTC'),
        currency: str(raw.currency, 'BDT'),
        takings: toMinor(raw.today_sales as string),
        orders: num(raw.order_count),
        grossProfit: toMinor(raw.gross_profit as string),
        itemsSold: num(raw.items_sold),
        discountGiven: toMinor(raw.discount_given as string),
        taxCollected: toMinor(raw.tax_collected as string),
        expenses: toMinor(raw.today_expenses as string),
        refunds: toMinor(raw.refunds_today as string),
        heldSales: num(raw.held_sales),
        pendingPayments: toMinor(raw.pending_payments as string),
        customerCount: num(raw.customer_count),
        outOfStock: num(raw.out_of_stock),
        lowStock: num(raw.low_stock),
        stockValue: toMinor(raw.stock_value as string),
        expectedCash: toMinor(raw.expected_cash as string),
        salesByHour,
        paymentMix,
        topProducts,
        answers: toAnswers(raw.answers),
        trendDays: daySlice,
        trendProfit: profitSlice,
        trendMonths: toSlice((raw.trend_months ?? {}) as RawSlice, true),
        rankProducts: toSlice((raw.rank_products ?? {}) as RawSlice, true),
        rankCategories: toSlice((raw.rank_categories ?? {}) as RawSlice, true),
        generatedAt: str(raw.generated_at),
      }

      // ── Branch scoping ──────────────────────────────────────────────────
      // `dashboard_summary` reports stock, reordering, receivable and payable
      // across the whole organization; on a multi-branch shop that is the wrong
      // answer for the branch on screen. Recompute the branch-attributable
      // figures from the same tables the Stock and khata screens use, then fold
      // them over the widgets. Takings, profit and expenses are already
      // branch-scoped inside the RPC, so they are left untouched.
      const [warehouseIds, owing] = await Promise.all([
        branchWarehouseIds(client, branchId),
        branchOwing(client, branchId),
      ])
      const stock: StockSummary =
        warehouseIds.length > 0
          ? await branchStockSummary(client, warehouseIds)
          : {
              stockValue: toMinor(0),
              variantsInStock: 0,
              lowStock: 0,
              outOfStock: 0,
              warehouses: 0,
              movementsToday: 0,
            }

      return {
        ...base,
        stockValue: stock.stockValue,
        lowStock: stock.lowStock,
        outOfStock: stock.outOfStock,
        answers: base.answers.map((answer) => {
          if (answer.id === 'receivable') {
            return {
              ...answer,
              amount: owing.receivable.amount,
              value: String(owing.receivable.amount),
              note: `${owing.receivable.parties} customer(s) owing on this branch's bills`,
            }
          }
          if (answer.id === 'payable') {
            return {
              ...answer,
              amount: owing.payable.amount,
              value: String(owing.payable.amount),
              note: `${owing.payable.parties} supplier(s) owed on this branch's purchases`,
            }
          }
          if (answer.id === 'reorder') {
            return {
              ...answer,
              count: stock.lowStock,
              value: String(stock.lowStock),
              note:
                stock.lowStock === 0
                  ? 'nothing is below its reorder point at this branch'
                  : `${stock.lowStock} item(s) at or below their reorder point`,
            }
          }
          return answer
        }),
      }
    },

    async slice(query: AnalyticsQuery): Promise<AnalyticsSlice> {
      const catalogValue = await catalog()
      const money = moneyMeasures(catalogValue)
      const data = unwrap(
        await client.rpc('analytics_query', {
          p_branch_id: query.branchId,
          p_dimension: query.dimension,
          p_measure: query.measure,
          p_period: query.period ?? 'month',
          p_from: dateOrNull(query.from),
          p_to: dateOrNull(query.to),
          p_filters: query.filters ?? {},
          p_limit: query.limit ?? 200,
        })
      )
      return toSlice((data ?? {}) as RawSlice, money.has(query.measure))
    },

    async answers({ branchId, day }: { branchId: string; day?: string }): Promise<BiAnswer[]> {
      const data = unwrap(
        await client.rpc('bi_answers', { p_branch_id: branchId, p_day: day ?? null })
      )
      return toAnswers(data)
    },
  }
}

/**
 * `''` and whitespace are not dates. PostgREST parses the argument before the
 * function sees it, so an empty string is a 400 rather than a NULL — the
 * boundary is where that has to be decided.
 */
function dateOrNull(value?: string): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function createReports(client: SupabaseClient): ReportRepository {
  return {
    async catalog(): Promise<ReportSummary[]> {
      const data = unwrap(await client.rpc('report_catalog'))
      if (!Array.isArray(data)) return []
      return data.map((entry) => {
        const report = (entry ?? {}) as Record<string, unknown>
        return {
          key: str(report.key),
          title: str(report.title),
          group: str(report.group, 'Other'),
          description: str(report.description),
          columns: toColumns(report.columns),
        }
      })
    },

    async run(query: ReportQuery): Promise<ReportResult> {
      const data = unwrap(
        await client.rpc('report_rows', {
          p_report: query.report,
          p_branch_id: query.branchId,
          p_period: query.period ?? 'month',
          p_from: dateOrNull(query.from),
          p_to: dateOrNull(query.to),
          p_search: query.search ?? null,
          p_sort: query.sort ?? null,
          p_dir: query.dir ?? 'desc',
          p_limit: query.limit ?? 25,
          p_offset: query.offset ?? 0,
          p_filters: query.filters ?? {},
        })
      )
      const raw = (data ?? {}) as Record<string, unknown>
      const columns = toColumns(raw.columns)
      const moneyKeys = new Set(
        columns.filter((column) => column.type === 'money').map((column) => column.key)
      )

      const rows: ReportRow[] = Array.isArray(raw.rows)
        ? raw.rows.map((entry) => {
            const row = (entry ?? {}) as Record<string, unknown>
            const converted: ReportRow = {}
            for (const column of columns) {
              const value = row[column.key]
              if (value === undefined) continue
              if (value === null) {
                converted[column.key] = null
              } else if (column.type === 'money') {
                converted[column.key] = toMinor(value as string)
              } else if (column.type === 'qty' || column.type === 'int' || column.type === 'percent') {
                converted[column.key] = num(value)
              } else {
                converted[column.key] = str(value)
              }
            }
            return converted
          })
        : []

      const totalsRaw = (raw.totals ?? {}) as Record<string, unknown>
      const totals: Record<string, number> = {}
      for (const [key, value] of Object.entries(totalsRaw)) {
        totals[key] = moneyKeys.has(key) ? (toMinor(value as string) as number) : num(value)
      }

      return {
        key: str(raw.key, query.report),
        title: str(raw.title),
        group: str(raw.group, 'Other'),
        description: str(raw.description),
        columns,
        rows,
        totals,
        totalRows: num(raw.total_rows),
        offset: num(raw.offset),
        limit: num(raw.limit, 25),
        sort: str(raw.sort),
        dir: str(raw.dir, 'desc') === 'asc' ? 'asc' : 'desc',
        search: raw.search === null || raw.search === undefined ? null : str(raw.search),
        period: str(raw.period, 'month'),
        label: str(raw.label),
        from: str(raw.from),
        to: str(raw.to),
        currency: str(raw.currency, 'BDT'),
        generatedAt: str(raw.generated_at),
      }
    },
  }
}

function toColumns(raw: unknown): ReportColumn[] {
  if (!Array.isArray(raw)) return []
  const types: ReportColumnType[] = ['text', 'money', 'qty', 'int', 'percent', 'date', 'status']
  return raw.map((entry) => {
    const column = (entry ?? {}) as Record<string, unknown>
    const type = str(column.type, 'text') as ReportColumnType
    const resolved = types.includes(type) ? type : 'text'
    const align = str(column.align) === 'right' ? ('right' as const) : ('left' as const)
    return align === 'right'
      ? { key: str(column.key), label: str(column.label), type: resolved, align }
      : { key: str(column.key), label: str(column.label), type: resolved }
  })
}

// ── Composition ───────────────────────────────────────────────────────────

/**
 * Build the whole data surface for one signed-in user.
 *
 * `organizationId` is a getter rather than a value because the user can switch
 * shops without a reload; reading it lazily means the repositories follow the
 * session instead of pinning the organization they were built with.
 */
// ── Plugins ───────────────────────────────────────────────────────────────
//
// The plugin host's data surface. Every call takes the organization explicitly
// because plugin state is per shop — the same bundle enables a different set
// of plugins in each — and the database re-checks membership on every one of
// them (migration 026).

/** Postgres returns jsonb numbers as strings when they are `numeric`. */
function jsonNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function toPluginEntry(entry: unknown): PluginCatalogEntry {
  const row = (entry ?? {}) as Record<string, unknown>
  const permissions = Array.isArray(row.permissions) ? row.permissions : []
  return {
    key: str(row.key),
    name: str(row.name, str(row.key)),
    category: (str(row.category, 'optional') as PluginCatalogEntry['category']),
    version: str(row.version, '0.0.0'),
    coreApiVersion: str(row.core_api_version, '*'),
    description: row.description === null || row.description === undefined ? null : str(row.description),
    dependencies: Array.isArray(row.dependencies) ? row.dependencies.map((d) => str(d)) : [],
    conflicts: Array.isArray(row.conflicts) ? row.conflicts.map((d) => str(d)) : [],
    installed: row.installed === true,
    enabled: row.enabled === true,
    status: str(row.status, 'ok') === 'error' ? 'error' : 'ok',
    lastError: row.last_error === null || row.last_error === undefined ? null : str(row.last_error),
    config: (row.config ?? {}) as Record<string, unknown>,
    enabledAt: row.enabled_at === null || row.enabled_at === undefined ? null : str(row.enabled_at),
    permissions: permissions.map((permission) => {
      const p = (permission ?? {}) as Record<string, unknown>
      return {
        key: str(p.key),
        label: str(p.label, str(p.key)),
        category: str(p.category, 'other'),
        description: p.description === null || p.description === undefined ? null : str(p.description),
      }
    }),
    migrationsTotal: num(row.migrations_total),
    migrationsPending: num(row.migrations_pending),
  }
}

/** Exported for its own test: the mapping from RPC payload to contract. */
export function createPlugins(client: SupabaseClient): PluginRepository {
  return {
    async catalog(organization: string): Promise<PluginCatalogEntry[]> {
      const data = unwrap(await client.rpc('plugin_catalog', { p_organization_id: organization }))
      if (!Array.isArray(data)) return []
      return data.map(toPluginEntry).sort((a, b) => a.name.localeCompare(b.name))
    },

    async state(organization: string): Promise<PluginStateEntry[]> {
      const data = unwrap(await client.rpc('plugin_state', { p_organization_id: organization }))
      if (!Array.isArray(data)) return []
      return data.map((entry) => {
        const row = (entry ?? {}) as Record<string, unknown>
        return {
          key: str(row.key),
          version: str(row.version),
          enabled: row.enabled === true,
          status: row.status === 'error' ? 'error' : 'ok',
          lastError: row.last_error === null || row.last_error === undefined ? null : str(row.last_error),
          config: (row.config ?? {}) as Record<string, unknown>,
        }
      })
    },

    async impact(organization: string, pluginKey: string): Promise<PluginImpactRole[]> {
      const data = unwrap(
        await client.rpc('plugin_impact', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
        })
      )
      if (!Array.isArray(data)) return []
      return data.map((entry) => {
        const row = (entry ?? {}) as Record<string, unknown>
        return {
          roleId: str(row.role_id),
          roleKey: str(row.role_key),
          roleName: str(row.role_name, str(row.role_key)),
          wildcard: str(row.wildcard, '*'),
          permissions: Array.isArray(row.permissions) ? row.permissions.map((k) => str(k)) : [],
        }
      })
    },

    async enable(organization, pluginKey, version, config) {
      const data = unwrap(
        await client.rpc('plugin_enable', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
          p_version: version,
          p_config: config ?? {},
        })
      )
      const row = (data ?? {}) as Record<string, unknown>
      return {
        key: str(row.plugin_key, pluginKey),
        version: str(row.version, version),
        enabled: row.enabled !== false,
        migrationsApplied: num(row.migrations_applied),
        permissions: num(row.permissions),
      }
    },

    async disable(organization, pluginKey) {
      const data = unwrap(
        await client.rpc('plugin_disable', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
        })
      )
      const row = (data ?? {}) as Record<string, unknown>
      return { key: str(row.plugin_key, pluginKey), enabled: row.enabled === true }
    },

    async setConfig(organization, pluginKey, config) {
      const data = unwrap(
        await client.rpc('plugin_set_config', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
          p_config: config,
        })
      )
      const row = (data ?? {}) as Record<string, unknown>
      return {
        key: str(row.plugin_key, pluginKey),
        config: (row.config ?? config) as Record<string, unknown>,
      }
    },

    async dataGet(organization, pluginKey, key) {
      return unwrap(
        await client.rpc('plugin_data_get', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
          p_key: key,
        })
      )
    },

    async dataSet(organization, pluginKey, key, value) {
      unwrap(
        await client.rpc('plugin_data_set', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
          p_key: key,
          p_value: value ?? null,
        })
      )
    },

    async dataDelete(organization, pluginKey, key) {
      return unwrap(
        await client.rpc('plugin_data_delete', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
          p_key: key,
        })
      ) === true
    },

    async products(organization: string): Promise<ProductSnapshot[]> {
      const data = unwrap(
        await client.rpc('plugin_products', { p_organization_id: organization })
      )
      if (!Array.isArray(data)) return []
      return data.map((entry) => {
        const row = (entry ?? {}) as Record<string, unknown>
        return {
          id: str(row.id),
          name: str(row.name),
          sku: row.sku === null || row.sku === undefined ? null : str(row.sku),
          price: jsonNumber(row.price),
          track_stock: row.track_stock === true,
          is_active: row.is_active !== false,
          reorder_point: jsonNumber(row.reorder_point),
          metadata: (row.metadata ?? {}) as Record<string, unknown>,
        }
      })
    },

    async rpc<T>(
      organization: string,
      pluginKey: string,
      fn: string,
      args?: Record<string, unknown>
    ): Promise<T> {
      return unwrap(
        await client.rpc('plugin_rpc', {
          p_organization_id: organization,
          p_plugin_key: pluginKey,
          p_function: fn,
          p_args: args ?? {},
        })
      ) as T
    },
  }
}

export function createSupabaseRepositories(
  client: SupabaseClient,
  organizationId: () => string | null
): Repositories {
  return {
    catalog: createCatalog(client, organizationId),
    products: createProducts(client, organizationId),
    customers: createCustomers(client, organizationId),
    sales: createSales(client),
    registers: createRegisters(client),
    organization: createOrganization(client, organizationId),
    stock: createStock(client, organizationId),
    suppliers: createSuppliers(client, organizationId),
    purchases: createPurchases(client),
    expenses: createExpenses(client, organizationId),
    returns: createReturns(client),
    audit: createAudit(client),
    analytics: createAnalytics(client),
    reports: createReports(client),
    plugins: createPlugins(client),
  }
}

export type { SaleItemPayload, SalePaymentPayload, SalesFloor }
