/**
 * Repository contracts (docs/03 §3, spec §42, §43).
 *
 * These interfaces are the seam the whole offline and Android story rests on.
 * A feature asks a contract for data; it never imports `@supabase/supabase-js`.
 * Swapping PostgREST for IndexedDB, or for a queue that replays writes when
 * the connection returns, is then a change to the composition root and nothing
 * else — which is what makes "Android needs no rewrite" a property of the
 * code rather than a hope.
 *
 * Two rules the contracts enforce by shape:
 *
 *   Reads are plain queries. Writes go through named operations that map
 *   one-to-one onto Postgres RPCs, because the RPC is where the row locks,
 *   the stock check and the ledger write happen together. A write method that
 *   took a partial row would invite a client to reimplement that logic.
 *
 *   Money and quantities cross the boundary as branded integers, never as
 *   strings. Postgres returns `numeric` as text; the Supabase implementation
 *   converts, so no feature ever parses a number itself and no feature can
 *   accidentally send a float where the database wants 14,2.
 */

import type {
  Brand,
  Category,
  CompletedSale,
  CustomerDraft,
  CustomerRow,
  Page,
  PageRequest,
  PaymentMethod,
  ProductDraft,
  ProductRow,
  RegisterRow,
  RegisterSessionRow,
  ResumedSale,
  SaleRow,
  Tax,
  Unit,
  VariantRow,
} from '../../types/records'
import type { Cart, PaymentEntry, SaleItemPayload, SalePaymentPayload } from '../../domain/cart'
import type { Milli, Minor } from '../../domain/money'

/** One row of the POS grid, with money and stock already converted. */
export interface SellableProduct {
  productId: string
  variantId: string
  name: string
  variantName: string | null
  sku: string | null
  imageUrl: string | null
  price: Minor
  /** Ten-thousandths of a taka, matching `numeric(14,4)`. */
  cost: number
  taxRatePercent: number
  taxInclusive: boolean
  trackStock: boolean
  allowNegative: boolean
  availableQty: Milli | null
  unitLabel: string | null
  decimalQuantity: boolean
  categoryName: string | null
  /**
   * `products.metadata`, carried to the till so plugin-registered fields
   * (`showInPOS`, `printable`) have something to render. Free: the catalogue
   * view already selects the column.
   */
  metadata: Record<string, unknown>
}

export interface ProductQuery extends PageRequest {
  /** Matched against the trigram-indexed `search_text`, plus exact SKU. */
  search?: string
  categoryId?: string | null
  /** Hide products that cannot be sold right now. */
  onlyInStock?: boolean
  categoryIdOrNull?: never
}

export interface CatalogRepository {
  /** The POS hot path: search, priced, with stock for one warehouse. */
  searchProducts(query: ProductQuery & { warehouseId: string }): Promise<Page<SellableProduct>>

  /** Exact barcode hit, or null. A scan is never a fuzzy match. */
  findByBarcode(code: string, warehouseId: string): Promise<SellableProduct | null>

  /**
   * One variant by id. Used to rebuild a held cart, where the stored rows are
   * variant ids and quantities and nothing else.
   */
  findByVariantId(variantId: string, warehouseId: string): Promise<SellableProduct | null>

  listCategories(): Promise<Category[]>
  createCategory(name: string, parentId?: string | null): Promise<Category>
  listBrands(): Promise<Brand[]>
  createBrand(name: string): Promise<Brand>
  listUnits(): Promise<Unit[]>
  listTaxes(): Promise<Tax[]>
  listAllTaxes(): Promise<Tax[]>
  createTax(name: string, rate: number, isInclusive: boolean): Promise<Tax>
  updateTax(id: string, draft: { name?: string; rate?: number; is_inclusive?: boolean; is_active?: boolean }): Promise<Tax>
  listPaymentMethods(): Promise<PaymentMethod[]>
  listAllPaymentMethods(): Promise<PaymentMethod[]>
  updatePaymentMethod(id: string, draft: Partial<Pick<PaymentMethod, 'name' | 'is_active' | 'sort_order' | 'icon' | 'config'>>): Promise<PaymentMethod>
}

export interface ProductBarcode {
  id: string
  variantId: string
  code: string
  isPrimary: boolean
}

export interface ProductRepository {
  list(query: ProductQuery): Promise<Page<ProductRow>>
  get(id: string): Promise<ProductRow | null>
  /** Includes variants, so the form can render and re-submit them. */
  getWithVariants(id: string): Promise<{ product: ProductRow; variants: VariantRow[] } | null>
  listBarcodes(productId: string): Promise<ProductBarcode[]>
  replaceBarcodes(variantId: string, codes: string[]): Promise<ProductBarcode[]>
  create(draft: ProductDraft): Promise<ProductRow>
  update(id: string, draft: Partial<ProductDraft>): Promise<ProductRow>
  /** Soft delete: the row stays, `deleted_at` hides it. */
  archive(id: string): Promise<void>
  /**
   * Hard delete — the row leaves the database.
   *
   * Mekholi has no trash view, so an archived product is invisible *and*
   * permanent, which is the wrong end state for the mistakes made while a
   * shop is being set up. `delete_product` (migration 053) removes the
   * product and the rows that merely describe it, and refuses when a sale,
   * return or purchase points at it — those are the books.
   */
  remove(id: string): Promise<void>
  /**
   * Stock on hand per product, in milli-units, for the rows currently listed.
   *
   * The Products list showed a "Tracked" badge where a shopkeeper expects a
   * number. One extra query per page beats a join that would slow the list
   * for the shops that do not track stock at all.
   */
  onHand(productIds: string[], warehouseId?: string | null): Promise<Record<string, Milli>>
  /** Spec §9 method 3: copy everything except the identity and the SKU. */
  duplicate(id: string): Promise<ProductRow>
}

export interface SaleRepository {
  /**
   * The only way a sale is written. Maps to `public.complete_sale`, which
   * locks the stock rows, checks the balance, writes the ledger and emits the
   * outbox event in one transaction.
   */
  complete(input: {
    branchId: string
    registerId: string | null
    warehouseId: string | null
    customerId: string | null
    items: SaleItemPayload[]
    payments: SalePaymentPayload[]
    discountType?: 'FLAT' | 'PERCENT'
    discountValue?: number
    note?: string
    /** Cancels the held row this cart came from, atomically (migration 021). */
    heldSaleId?: string | null
    /**
     * The device's identity for this sale (migration 044). Supplied by the
     * offline queue so a resend after an unclear outcome is recognised by the
     * server as the sale it already wrote, rather than becoming a second one.
     * Online callers omit it and the server generates nothing — the column
     * stays NULL, which is what keeps the unique index small.
     */
    clientRef?: string | null
    /**
     * The till's own account of the sale: the cart, and the currency it was
     * priced in.
     *
     * Used only when the sale ends up queued. The wire payload above holds what
     * the *server* needs to price the sale (variant, quantity, discount); it
     * does not hold the product names, unit prices or tax rates a printed slip
     * needs, because the server owns all three. So the offline layer is handed
     * a copy of the cart it may print from — the same arithmetic that drew the
     * total on screen a second earlier (`computeTotals`) and nothing more. The
     * server-side implementation ignores this field entirely: it has the row.
     */
    local?:
      | {
          cart: Cart
          currency: string
          /**
           * The open register session, for the printed slip only. The server
           * resolves the session itself when it stores the sale.
           */
          sessionId?: string | null
        }
      | null
  }): Promise<CompletedSale>

  hold(input: {
    branchId: string
    items: SaleItemPayload[]
    customerId: string | null
    note?: string
  }): Promise<string>

  resume(saleId: string): Promise<ResumedSale>

  /** Newest first, this branch only. */
  list(query: PageRequest & { branchId: string; status?: string[] }): Promise<Page<SaleRow>>
  /** The sales list for a shop, across branches, for the Sales screen. */
  listAll(query: PageRequest & { status?: string; search?: string; from?: string; to?: string }): Promise<Page<SalesListRow>>
  detail(id: string): Promise<SaleDetail | null>
  get(id: string): Promise<SaleRow | null>
  held(branchId: string): Promise<SaleRow[]>
  byCustomer(customerId: string, query?: PageRequest): Promise<Page<SaleRow>>
}

export interface CustomerRepository {
  list(query: PageRequest & { search?: string }): Promise<Page<CustomerRow>>
  get(id: string): Promise<CustomerRow | null>
  /** Spec §19: name and phone are enough. Everything else is optional. */
  create(draft: CustomerDraft): Promise<CustomerRow>
  update(id: string, draft: Partial<CustomerDraft>): Promise<CustomerRow>
  /**
   * Money in against what this customer owes — the khata collection. Maps to
   * `collect_customer_payment`: without a `saleId` the amount pays the open
   * sales oldest first; with one it pays that invoice alone. Collecting more
   * than is owed is refused by the database, not the dialog.
   */
  collectPayment(input: {
    customerId: string
    amount: Minor
    methodId: string
    saleId?: string | null
    reference?: string | null
  }): Promise<{ collected: Minor; balance: Minor; settledSales: number }>
}

export interface RegisterRepository {
  list(branchId: string): Promise<RegisterRow[]>
  currentSession(branchId: string): Promise<RegisterSessionRow | null>
  open(registerId: string, openingCash: Minor, note?: string): Promise<string>
  close(sessionId: string, closingCash: Minor, note?: string): Promise<void>
  /** `direction` is 1 for cash in and -1 for cash out, as the RPC expects. */
  cashMovement(sessionId: string, amount: Minor, direction: 1 | -1, note?: string): Promise<void>
  /** Recent sessions for the register screen's history. */
  sessions(branchId: string, limit?: number): Promise<RegisterSessionSummary[]>
  /** The closing report: expected vs counted, and where the money came from. */
  report(sessionId: string): Promise<RegisterReport>
}

/**
 * Everything a screen needs to know about *where* it is selling.
 *
 * Resolved once per session rather than per screen: the branch decides the
 * warehouse, the warehouse decides stock, and the register decides where the
 * cash is counted. Getting these out of step is the bug that shows up as a
 * sale recorded against the wrong shop.
 */
export interface SalesFloor {
  branchId: string
  branchName: string
  warehouseId: string
  warehouseName: string
  registerId: string | null
  registerName: string | null
  sessionId: string | null
}

export interface OrganizationSettings {
  id: string
  name: string
  slug: string
  currency: string
  timezone: string
  locale: string
  logoUrl: string | null
  settings: Record<string, unknown>
}

export interface StaffRoleAssignment {
  id: string
  key: string
  name: string
}

export interface StaffRow {
  kind: 'member' | 'pending'
  userId: string | null
  email: string
  name: string
  isActive: boolean
  roles: StaffRoleAssignment[]
  branches: { id: string; name: string }[]
  invitationId: string | null
  invitedAt: string | null
  expiresAt: string | null
}

export interface RoleRow {
  id: string
  key: string
  name: string
  isSystem: boolean
  permissionKeys: string[]
}

export interface OrganizationRepository {
  /** The branch this user sells from, and the resources hanging off it. */
  salesFloor(branchId: string): Promise<SalesFloor>
  listBranches(): Promise<{ id: string; name: string; code: string | null; is_primary: boolean }[]>
  getSettings(): Promise<OrganizationSettings>
  updateSettings(input: Partial<Pick<OrganizationSettings, 'name' | 'currency' | 'timezone' | 'locale' | 'logoUrl'>> & { settings?: Record<string, unknown> }): Promise<OrganizationSettings>
  listStaff(): Promise<StaffRow[]>
  inviteStaff(email: string, roleId: string, branchId?: string | null): Promise<{ id: string; email: string; expiresAt: string }>
  removeStaff(userId: string): Promise<void>
  listPermissions(): Promise<{ id: string; key: string; label: string; category: string }[]>
  listRoles(): Promise<RoleRow[]>
  createRole(name: string, key: string, permissionKeys: string[]): Promise<RoleRow>
  updateRole(id: string, name: string, permissionKeys: string[]): Promise<RoleRow>
  deleteRole(id: string): Promise<void>
  setStaffRoles(userId: string, roleIds: string[], branchId?: string | null): Promise<void>
}

/**
 * The whole data surface, so a feature takes one dependency rather than six.
 *
 * Deliberately not a god object: it composes the narrow contracts above and
 * adds nothing of its own. A feature that only reads the catalogue can still
 * depend on `CatalogRepository` directly, which keeps its real requirements
 * visible in its signature.
 */
// ── Inventory (Phase 3) ───────────────────────────────────────────────────

/**
 * One line of the stock list: a variant in a warehouse, with what it is worth.
 *
 * Quantities are `Milli` (thousandths) and money is `Minor`, converted at the
 * repository boundary so no screen parses a numeric itself — the same rule the
 * rest of the data surface follows.
 */
export interface StockRow {
  variantId: string
  productId: string
  productName: string
  variantName: string | null
  sku: string | null
  warehouseId: string
  warehouseName: string
  quantity: Milli
  avgUnitCost: Minor
  stockValue: Minor
  reorderPoint: Milli
  trackStock: boolean
  isLow: boolean
  isOut: boolean
  updatedAt: string
}

/** A ledger entry, with the before/after that makes it an explanation. */
export interface StockMovementRow {
  id: string
  createdAt: string
  type: string
  direction: 1 | -1
  quantity: Milli
  /** Signed: positive for stock in, negative for stock out. */
  delta: Milli
  beforeQuantity: Milli
  afterQuantity: Milli
  unitCost: Minor
  warehouseId: string
  warehouseName: string
  variantId: string
  productName: string
  variantName: string | null
  referenceType: string | null
  referenceId: string | null
  note: string | null
  userId: string | null
}

/** The numbers the stock screen header and the dashboard card both show. */
export interface StockSummary {
  stockValue: Minor
  variantsInStock: number
  lowStock: number
  outOfStock: number
  warehouses: number
  movementsToday: number
}

export interface StockLineInput {
  variantId: string
  qty: Milli
  /** Omitted on a receipt means "use the product's last known cost". */
  unitCost?: Minor
}

/** What a stock operation reports back, for the confirmation message. */
export interface StockOperationResult {
  lineCount: number
  totalQty: Milli
  /** Receipts only. */
  totalCost?: Minor
  /** Transfers only. */
  transferId?: string
}

/** Query for the stock list. Every filter is optional and composes. */
export interface StockQuery extends PageRequest {
  search?: string
  warehouseId?: string
  /** The tabs above the list. */
  filter?: 'all' | 'low' | 'out'
}

/** A warehouse the stock screens can move stock between. */
export interface WarehouseOption {
  id: string
  name: string
  isRetailFloor: boolean
}

export interface StockRepository {
  /** One page of stock, newest movement first within each product. */
  list(query: StockQuery): Promise<Page<StockRow>>
  /** The ledger for one variant — the answer to "why 37 units?". */
  history(variantId: string, query: PageRequest & { warehouseId?: string }): Promise<Page<StockMovementRow>>
  /** Recent movements across the shop, for the overview's activity list. */
  recent(query: PageRequest & { warehouseId?: string }): Promise<Page<StockMovementRow>>
  summary(): Promise<StockSummary>

  listWarehouses(): Promise<WarehouseOption[]>

  /**
   * Writes. Each maps to exactly one Postgres function, because the function
   * is where the row lock, the stock check and the ledger write happen
   * together — a client that wrote the balance itself would be a second
   * implementation of the invariant.
   */
  stockIn(
    warehouseId: string,
    lines: StockLineInput[],
    options?: { supplierId?: string | null; reference?: string | null; note?: string | null }
  ): Promise<StockOperationResult>
  stockOut(
    warehouseId: string,
    lines: { variantId: string; qty: Milli }[],
    reason: string,
    note?: string | null
  ): Promise<StockOperationResult>
  transfer(
    fromWarehouseId: string,
    toWarehouseId: string,
    lines: { variantId: string; qty: Milli }[],
    note?: string | null
  ): Promise<StockOperationResult>
  adjust(
    warehouseId: string,
    variantId: string,
    qty: Milli,
    reason: string,
    direction: 1 | -1,
    note?: string | null
  ): Promise<void>
  /** Reorder point lives on the product; editing it is a product update. */
  setReorderPoint(productId: string, reorderPoint: Milli): Promise<void>
}

// ── Purchasing and suppliers (Phase 4) ────────────────────────────────────

/**
 * A supplier, with the balance the shop owes them.
 *
 * `balance` is positive when the shop owes money and negative when the
 * supplier holds an advance — the same sign convention `receive_purchase` and
 * `apply_payment` maintain in the database.
 */
export interface SupplierRow {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  note: string | null
  balance: Minor
  createdAt: string
  updatedAt: string
}

export interface SupplierDraft {
  name: string
  phone?: string | null
  email?: string | null
  address?: string | null
  note?: string | null
}

export interface PurchaseRow {
  id: string
  invoiceNo: string
  referenceNo: string | null
  status: 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED'
  supplierId: string | null
  supplierName: string | null
  warehouseId: string
  warehouseName: string | null
  subtotal: Minor
  taxTotal: Minor
  total: Minor
  paidTotal: Minor
  /** What is still owed on this order. */
  outstanding: Minor
  note: string | null
  expectedAt: string | null
  createdAt: string
  receivedAt: string | null
}

export interface PurchaseItemRow {
  id: string
  variantId: string
  productName: string
  variantName: string | null
  quantity: Milli
  receivedQty: Milli
  /** quantity − received_qty: what is still to come. */
  outstanding: Milli
  unitCost: Minor
  lineTotal: Minor
}

export interface PurchasePaymentRow {
  id: string
  amount: Minor
  methodId: string
  methodName: string | null
  reference: string | null
  paidAt: string
}

export interface PurchaseDetail {
  purchase: PurchaseRow
  items: PurchaseItemRow[]
  payments: PurchasePaymentRow[]
}

export interface PurchaseDraftLine {
  variantId: string
  qty: Milli
  unitCost: Minor
  taxRate?: number
}

export interface PurchaseRepository {
  list(query: PageRequest & { status?: string; supplierId?: string; search?: string }): Promise<Page<PurchaseRow>>
  get(id: string): Promise<PurchaseDetail | null>
  /** Creates when `id` is absent. Returns the purchase id. */
  save(input: {
    id?: string
    warehouseId: string
    supplierId: string | null
    lines: PurchaseDraftLine[]
    status: 'DRAFT' | 'ORDERED'
    referenceNo?: string | null
    note?: string | null
    expectedAt?: string | null
  }): Promise<string>
  receive(
    id: string,
    lines: { purchaseItemId: string; qty: Milli; unitCost?: Minor }[],
    payments: { methodId: string; amount: Minor; reference?: string }[]
  ): Promise<{ status: string; receivedValue: Minor; paid: Minor }>
  cancel(id: string, reason?: string | null): Promise<{ released: Minor }>
  pay(input: {
    supplierId: string
    amount: Minor
    methodId: string
    purchaseId?: string | null
    reference?: string | null
  }): Promise<{ supplierBalance: Minor }>
}

export interface SupplierRepository {
  list(query: PageRequest & { search?: string }): Promise<Page<SupplierRow>>
  get(id: string): Promise<SupplierRow | null>
  create(draft: SupplierDraft): Promise<SupplierRow>
  update(id: string, draft: Partial<SupplierDraft>): Promise<SupplierRow>
  /** What we bought from them, newest first — the supplier's history. */
  purchases(supplierId: string, query?: PageRequest): Promise<Page<PurchaseRow>>
}

// ── Expenses (Phase 4) ────────────────────────────────────────────────────

export interface ExpenseRow {
  id: string
  expenseDate: string
  amount: Minor
  categoryId: string | null
  categoryName: string | null
  methodId: string | null
  methodName: string | null
  isCash: boolean
  description: string | null
  attachmentUrl: string | null
  sessionId: string | null
  createdAt: string
}

export interface ExpenseCategoryRow {
  id: string
  name: string
  isSystem: boolean
}

export interface ExpenseRepository {
  list(query: PageRequest & { from?: string; to?: string; categoryId?: string; search?: string }): Promise<Page<ExpenseRow>>
  /** Today's total, for the header. */
  totalForDay(date: string): Promise<Minor>
  create(input: {
    branchId: string
    amount: Minor
    categoryId?: string | null
    methodId?: string | null
    description?: string | null
    sessionId?: string | null
    expenseDate?: string
  }): Promise<string>
  update(id: string, patch: { amount?: Minor; categoryId?: string | null; description?: string | null }): Promise<void>
  /** Soft delete: `deleted_at`, so the register's history stays reconcilable. */
  remove(id: string): Promise<void>
  categories(): Promise<ExpenseCategoryRow[]>
  createCategory(name: string): Promise<ExpenseCategoryRow>
  removeCategory(id: string): Promise<void>
}

// ── Returns (Phase 4, spec §18) ───────────────────────────────────────────

export interface SaleReturnRow {
  id: string
  returnNo: string
  createdAt: string
  reason: string | null
  restock: boolean
  refundTotal: Minor
  items: { saleItemId: string; quantity: Milli; refundAmount: Minor; productName: string }[]
}

export interface RefundResult {
  returnId: string
  refundTotal: Minor
  saleStatus: string
  /** Present on a store-credit refund. */
  storeCredit?: Minor
}

export interface SalesListRow {
  id: string
  invoiceNo: string
  status: string
  customerId: string | null
  customerName: string | null
  branchName: string | null
  total: Minor
  paidTotal: Minor
  createdAt: string
  completedAt: string | null
}

export interface SaleDetail {
  sale: SalesListRow
  items: {
    id: string
    productName: string
    variantName: string | null
    quantity: Milli
    returnedQty: Milli
    unitPrice: Minor
    lineTotal: Minor
  }[]
  payments: { id: string; methodName: string | null; amount: Minor; receivedAt: string }[]
  returns: SaleReturnRow[]
}

export interface ReturnsRepository {
  /** Refund to the original payment methods. */
  refund(input: {
    saleId: string
    lines: { saleItemId: string; qty: Milli }[]
    payments: { methodId: string; amount: Minor; reference?: string }[]
    reason?: string | null
    restock?: boolean
  }): Promise<RefundResult>
  /** Refund to the customer's store credit instead of cash. */
  refundToCredit(input: {
    saleId: string
    lines: { saleItemId: string; qty: Milli }[]
    reason?: string | null
    restock?: boolean
  }): Promise<RefundResult>
}

// ── Register reporting (Phase 4) ──────────────────────────────────────────

/**
 * A session as the register screen lists it, with the day's totals already
 * aggregated. Computed by the `register_session_summary` view so the list and
 * the closing report cannot disagree about what a session took.
 */
export interface RegisterSessionSummary {
  id: string
  registerId: string
  registerName: string | null
  branchId: string
  openedAt: string
  closedAt: string | null
  isOpen: boolean
  openingCash: Minor
  closingCash: Minor | null
  variance: Minor | null
  salesTotal: Minor
  saleCount: number
  refundTotal: Minor
  expenseTotal: Minor
}

export interface RegisterReport {
  sessionId: string
  isOpen: boolean
  openedAt: string
  closedAt: string | null
  openingCash: Minor
  cashIn: Minor
  cashOut: Minor
  salesCash: Minor
  refundCash: Minor
  expenseCash: Minor
  expectedCash: Minor
  closingCash: Minor | null
  variance: Minor | null
  saleCount: number
  salesTotal: Minor
  refundTotal: Minor
  expenseTotal: Minor
  byMethod: { methodId: string; method: string; isCash: boolean; amount: Minor; count: number }[]
}

// ── Audit trail (Phase 4, spec §31) ───────────────────────────────────────

export interface AuditEntry {
  id: string
  createdAt: string
  action: 'create' | 'update' | 'delete'
  entityType: string
  entityId: string | null
  actorId: string | null
  actorEmail: string | null
  /** The row as it was; null for a create. */
  before: Record<string, unknown> | null
  /** The row as it became; null for a delete. */
  after: Record<string, unknown> | null
}

export interface AuditRepository {
  list(query: PageRequest & {
    entityType?: string
    actorId?: string
    action?: string
    entityId?: string
    search?: string
  }): Promise<Page<AuditEntry>>
  entityTypes(): Promise<string[]>
}

// ── Analytics (Phase 5, spec §21, §22, §56) ───────────────────────────────

/**
 * The measures and dimensions the server can actually answer.
 *
 * Fetched from `analytics_catalog()` rather than written here: the supported
 * (measure × dimension) pairs come from the same matrix the SQL generator
 * uses, so a picker cannot offer a combination that would fail, and a new
 * measure becomes selectable without a client change.
 */
export interface AnalyticsMeasure {
  id: string
  label: string
  /** Money measures are branded minor units once converted; counts are not. */
  money: boolean
  unit: string
  description: string
}

export interface AnalyticsDimension {
  id: string
  label: string
  group: string
  /** `time` dimensions read left-to-right; `entity` dimensions are rankings. */
  kind: 'time' | 'entity'
}

export interface AnalyticsCombo {
  measure: string
  dimension: string
}

export interface AnalyticsCatalog {
  measures: AnalyticsMeasure[]
  dimensions: AnalyticsDimension[]
  periods: { id: string; label: string }[]
  combos: AnalyticsCombo[]
}

/**
 * One point of a slice: this period's value, and the comparison period's.
 *
 * When the slice's measure is money, every field here is branded **minor
 * units** (poisha), not taka — so a chart labels 12,400.00 by reading the
 * integer, and no screen ever multiplies by 100 on its own. `money` on the
 * slice says which of the two it is.
 */
export interface AnalyticsPoint {
  key: string
  label: string
  value: number
  secondary: number
  prev: number
  prevSecondary: number
}

export interface AnalyticsTotals {
  value: number
  secondary: number
  prev: number | null
  prevSecondary: number | null
  /** Percentage change against the comparison period; null when it cannot be computed. */
  deltaPct: number | null
}

/**
 * The answer to one question — "Takings by category, this month" — with the
 * comparison period attached. The screen, the chart and the CSV all read this
 * one shape, which is what makes the chart and the table agree by construction.
 */
export interface AnalyticsSlice {
  dimension: string
  measure: string
  period: string
  /** True when `value` is money, so the caller formats rather than guesses. */
  money: boolean
  label: string
  timezone: string
  currency: string
  from: string
  to: string
  previousFrom: string
  previousTo: string
  series: AnalyticsPoint[]
  totals: AnalyticsTotals | null
  answers: BiAnswer[]
}

/** One question of the owner's morning list (spec §56), with its answer. */
export interface BiAnswer {
  id: string
  question: string
  kind: 'money' | 'count' | 'qty' | 'text'
  /** The answer as the server wrote it. Kept for `text` answers and for logs. */
  value: string
  /** Money answers in minor units, ready for `formatMoney`. */
  amount: Minor | null
  /** Count answers as a number, ready for a formatter. */
  count: number | null
  note: string
  /** Deep link to the screen that shows the detail. */
  link: string
  icon: string
}

/**
 * Everything the dashboard shows, from one call (docs/09 #10).
 *
 * Eight widgets, two trend lines, two rankings and the answer list — one
 * request, one transaction, so no two parts of the screen can describe
 * different moments in the same shop.
 */
export interface DashboardSummary {
  date: string
  timezone: string
  currency: string
  takings: Minor
  orders: number
  grossProfit: Minor
  itemsSold: number
  discountGiven: Minor
  taxCollected: Minor
  expenses: Minor
  refunds: Minor
  heldSales: number
  pendingPayments: Minor
  customerCount: number
  outOfStock: number
  lowStock: number
  stockValue: Minor
  expectedCash: Minor
  salesByHour: { hour: number; total: Minor }[]
  paymentMix: { method: string; total: Minor }[]
  topProducts: { name: string; qty: number; revenue: Minor }[]
  answers: BiAnswer[]
  /** Thirty days of takings, one point per day. */
  trendDays: AnalyticsSlice
  /** Thirty days of profit, the same days. */
  trendProfit: AnalyticsSlice
  /** This year by month. */
  trendMonths: AnalyticsSlice
  rankProducts: AnalyticsSlice
  rankCategories: AnalyticsSlice
  generatedAt: string
}

export interface AnalyticsQuery {
  branchId: string
  dimension: string
  measure: string
  period?: string
  from?: string
  to?: string
  limit?: number
  filters?: Record<string, string>
}

export interface AnalyticsRepository {
  /** Measures, dimensions, periods and the supported combinations. */
  catalog(): Promise<AnalyticsCatalog>
  /** Every widget, chart and answer, in one round trip. */
  dashboard(query: { branchId: string; day?: string }): Promise<DashboardSummary>
  /** One dimension of one measure over one period. */
  slice(query: AnalyticsQuery): Promise<AnalyticsSlice>
  /** The §56 question list on its own. */
  answers(query: { branchId: string; day?: string }): Promise<BiAnswer[]>
}

// ── Reports (Phase 5, spec §23) ───────────────────────────────────────────

export type ReportColumnType = 'text' | 'money' | 'qty' | 'int' | 'percent' | 'date' | 'status'

/** A report column as the server declares it — the table and CSV headers. */
export interface ReportColumn {
  key: string
  label: string
  type: ReportColumnType
  align?: 'left' | 'right'
}

/**
 * One cell. Money columns hold **minor units** so the table, the printout and
 * the CSV all format the same integer rather than a float that has already
 * been rounded once.
 */
export type ReportCell = string | number | null

/** One row, keyed by column key. Unknown columns are absent. */
export type ReportRow = Record<string, ReportCell>

export interface ReportSummary {
  key: string
  title: string
  group: string
  description: string
  columns: ReportColumn[]
}

/**
 * A report run: the page of rows, the columns to render them with, and the
 * totals of the whole filtered set — not of the page. `totalRows` is that same
 * filtered set's size, so "1–25 of 431" is one fact rather than two queries
 * that can disagree.
 */
export interface ReportResult extends ReportSummary {
  rows: ReportRow[]
  /** Column key → total. Money columns are in minor units. */
  totals: Record<string, number>
  totalRows: number
  offset: number
  limit: number
  sort: string
  dir: 'asc' | 'desc'
  search: string | null
  period: string
  label: string
  from: string
  to: string
  currency: string
  generatedAt: string
}

export interface ReportQuery {
  branchId: string
  report: string
  period?: string
  from?: string
  to?: string
  search?: string
  sort?: string
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
  filters?: Record<string, string>
}

export interface ReportRepository {
  /** The report library, with the columns each report returns. */
  catalog(): Promise<ReportSummary[]>
  /** Filter, search, sort, paginate — computed server-side. */
  run(query: ReportQuery): Promise<ReportResult>
}

/** One plugin this server ships, joined with this shop's state (migration 026). */
export interface PluginCatalogEntry {
  key: string
  name: string
  category: 'core' | 'optional' | 'industry'
  version: string
  coreApiVersion: string
  description: string | null
  dependencies: string[]
  conflicts: string[]
  installed: boolean
  enabled: boolean
  status: 'ok' | 'error'
  lastError: string | null
  config: Record<string, unknown>
  enabledAt: string | null
  permissions: Array<{ key: string; label: string; category: string; description: string | null }>
  migrationsTotal: number
  migrationsPending: number
}

/** A role that would gain a plugin's permissions through a wildcard. */
export interface PluginImpactRole {
  roleId: string
  roleKey: string
  roleName: string
  wildcard: string
  permissions: string[]
}

export interface PluginEnableResult {
  key: string
  version: string
  enabled: boolean
  migrationsApplied: number
  permissions: number
}

/**
 * The plugin host's own data surface, as contract methods (docs/05 §4).
 *
 * `rpc` is deliberately the only write path a plugin has: the function name is
 * checked against the plugin's namespace server-side, so a plugin can reach
 * its own functions and nothing else.
 */
export interface PluginStateEntry {
  key: string
  version: string
  enabled: boolean
  status: 'ok' | 'error'
  lastError: string | null
  config: Record<string, unknown>
}

export interface PluginRepository {
  /** Every package this server ships, with this shop's state folded in. */
  catalog(organizationId: string): Promise<PluginCatalogEntry[]>
  /**
   * What this shop has switched on, and nothing else.
   *
   * Separate from `catalog` because the two answer different questions to
   * different people: `catalog` is admin material and needs `plugins.view`,
   * while *loading the app* only needs to know which plugins are running. A
   * cashier must be able to load their shop's plugins without the admin
   * permission, so the app asks this and the Plugins screen asks `catalog`.
   */
  state(organizationId: string): Promise<PluginStateEntry[]>
  /** Who would silently gain permissions, before an enable is confirmed. */
  impact(organizationId: string, pluginKey: string): Promise<PluginImpactRole[]>
  enable(
    organizationId: string,
    pluginKey: string,
    version: string,
    config?: Record<string, unknown>
  ): Promise<PluginEnableResult>
  disable(organizationId: string, pluginKey: string): Promise<{ key: string; enabled: boolean }>
  setConfig(
    organizationId: string,
    pluginKey: string,
    config: Record<string, unknown>
  ): Promise<{ key: string; config: Record<string, unknown> }>
  /** Org-scoped plugin storage, backed by the RLS-protected table. */
  dataGet(organizationId: string, pluginKey: string, key: string): Promise<unknown>
  dataSet(organizationId: string, pluginKey: string, key: string, value: unknown): Promise<void>
  dataDelete(organizationId: string, pluginKey: string, key: string): Promise<boolean>
  /** The one read projection a plugin gets over core data. */
  products(organizationId: string): Promise<ProductSnapshot[]>
  /** Call one of the plugin's own functions. */
  rpc<T = unknown>(
    organizationId: string,
    pluginKey: string,
    fn: string,
    args?: Record<string, unknown>
  ): Promise<T>
}

/** Mirrors `public.plugin_products` (migration 029). */
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

export interface Repositories {
  readonly catalog: CatalogRepository
  readonly products: ProductRepository
  readonly sales: SaleRepository
  readonly customers: CustomerRepository
  readonly registers: RegisterRepository
  readonly organization: OrganizationRepository
  readonly stock: StockRepository
  readonly suppliers: SupplierRepository
  readonly purchases: PurchaseRepository
  readonly expenses: ExpenseRepository
  readonly returns: ReturnsRepository
  readonly audit: AuditRepository
  readonly analytics: AnalyticsRepository
  readonly reports: ReportRepository
  readonly plugins: PluginRepository
}

/** Re-exported so features can build payloads without importing the domain. */
export type { Cart, PaymentEntry, SaleItemPayload, SalePaymentPayload }
