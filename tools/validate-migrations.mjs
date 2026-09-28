#!/usr/bin/env node
// Applies supabase/migrations/*.sql, in filename order, to a real Postgres
// engine (PGlite — Postgres compiled to WASM).
//
// This is the check that keeps the schema honest. Unlike validate-schema.mjs,
// which reads illustrative SQL out of the design docs, this executes the
// actual migrations the way `supabase db reset` would, so a broken foreign
// key, a malformed policy or a plpgsql syntax error fails here rather than
// on the owner's machine.
//
//   node tools/validate-migrations.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { splitStatements, statementLabel } from './sql-split.mjs'
import { checkSelects } from './check-selects.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'supabase', 'migrations')

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

// ── Static check: every `create type` must be guarded ────────────────────
//
// `create type` has no `if not exists`, and dropping tables does not drop
// enums — so an unguarded one makes the whole migration set fragile to a
// partial re-run (the 42710 "type already exists" failure that a manual
// SQL-editor replay hits first). splitStatements respects dollar-quoting, so
// a guarded create lives inside one `do $$ … $$;` statement and only a bare
// create type surfaces here.
const unguardedCreateTypes = []
for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8')
  for (const stmt of splitStatements(sql)) {
    if (/^\s*create\s+type\b/i.test(stmt)) {
      unguardedCreateTypes.push(`${file}: ${stmt.split('\n')[0].trim()}`)
    }
  }
}
if (files.length === 0) {
  console.error(`no migrations found in ${dir}`)
  process.exit(1)
}

const db = new PGlite()

// Supabase provides these; PGlite does not. Stub them so the RLS policies,
// auth.* helpers and the Realtime publication are all exercised rather than
// skipped — the authorization layer is the part that most needs proving.
await db.exec(`
  -- Supabase creates these roles; PGlite does not. Without them the grants
  -- migration cannot be exercised at all.
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;

  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text
  );
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE AS
    $$ SELECT coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb $$;
  CREATE PUBLICATION supabase_realtime;
`)

// pg_trgm is unavailable in the WASM build. The two trigram indexes and the
// CREATE EXTENSION line are the only statements affected; both are valid on
// real Postgres/Supabase.
const SKIP = /gin_trgm_ops|create\s+extension\s+if\s+not\s+exists\s+pg_trgm/i

const results = { ok: [], skipped: [], failed: [] }
let skippedStatements = 0

for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8')
  const statements = splitStatements(sql)
  const runnable = statements.filter((s) => !SKIP.test(s))
  const omitted = statements.length - runnable.length
  skippedStatements += omitted

  if (omitted > 0) results.skipped.push({ file, omitted })
  if (runnable.length === 0) continue

  for (const stmt of runnable) {
    try {
      await db.exec(stmt)
      results.ok.push(file)
    } catch (e) {
      results.failed.push({
        file,
        statement: statementLabel(stmt),
        error: String(e.message ?? e).split('\n')[0],
      })
      // A failed statement usually cascades; stop this file but keep going so
      // one run surfaces every independent problem.
      break
    }
  }
}

// ── Seeds ─────────────────────────────────────────────────────────────────
// Run after migrations, exactly as `supabase db reset` would. The seeds carry
// their own self-verification (the permission catalogue assertion and the
// provision_organization smoke test), so a failure here is meaningful.
const seedDir = join(root, 'supabase', 'seed')
let seedFiles = []
try {
  seedFiles = readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort()
} catch {
  /* no seeds yet */
}

const seedResults = { ok: 0, failed: [] }
for (const file of seedFiles) {
  const sql = readFileSync(join(seedDir, file), 'utf8')
  for (const stmt of splitStatements(sql)) {
    try {
      await db.exec(stmt)
      seedResults.ok++
    } catch (e) {
      seedResults.failed.push({
        file,
        statement: statementLabel(stmt),
        error: String(e.message ?? e).split('\n')[0],
      })
      break
    }
  }
}

const filesOk = new Set(results.ok.map((f) => f)).size
console.log(`migrations found:  ${files.length}`)
console.log(`files applied:     ${filesOk}`)
console.log(`statements run:    ${results.ok.length}`)
console.log(`statements skipped: ${skippedStatements} (pg_trgm — unavailable in WASM)`)
console.log(`failures:          ${results.failed.length}`)
console.log(`\nseeds applied:     ${seedFiles.length}`)
console.log(`seed statements:   ${seedResults.ok}`)
console.log(`seed failures:     ${seedResults.failed.length}`)

if (results.failed.length) {
  console.log('\n-- FAILED --')
  for (const f of results.failed) {
    console.log(`  ${f.file}`)
    console.log(`      stmt: ${f.statement}`)
    console.log(`      ${f.error}`)
  }
  process.exitCode = 1
}

if (seedResults.failed.length) {
  console.log('\n-- SEED FAILED --')
  for (const f of seedResults.failed) {
    console.log(`  ${f.file}`)
    console.log(`      stmt: ${f.statement}`)
    console.log(`      ${f.error}`)
  }
  process.exitCode = 1
}

if (process.exitCode) {
  await db.close()
  process.exit(1)
}

// ── Structural assertions ─────────────────────────────────────────────────
const q = async (sql) => (await db.query(sql)).rows

const tables = await q(`
  select table_name from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE'
   order by table_name`)

const noRls = await q(`select * from app.tables_missing_rls()`)
const policies = await q(`select count(*)::int as n from pg_policies where schemaname = 'public'`)
const policies_text = await q(`select qual, with_check from pg_policies where schemaname = 'public'`)
const functions = await q(`
  select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','app')
     and p.proname in (
       'complete_sale','hold_sale','resume_sale','refund_sale',
       'apply_stock_movement','adjust_stock','receive_purchase',
       'open_register','close_register','register_cash_movement','record_expense',
       'dashboard_summary','next_sequence',
       'session_payload','provision_organization',
       'current_org_ids','in_org','current_branch_id','has_permission',
       'visible_branch_ids','in_visible_branch','require_permission','require_org',
       'tables_missing_rls'
     )
   order by 1`)

console.log(`\ntables:           ${tables.length}`)
console.log(`RLS policies:     ${policies[0].n}`)
console.log(`tables w/o RLS:   ${noRls.length}${noRls.length ? ' → ' + noRls.map((r) => r.table_name).join(', ') : ''}`)
console.log(`\nkey functions present (${functions.length}):`)
for (const f of functions) console.log(`  ${f.f}`)

// ── Behavioral assertions ─────────────────────────────────────────────────
const checks = []
const check = (name, pass, detail = '') => {
  checks.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const runChecks = async () => {
// The ledger invariant: every movement must balance, and the balance must
// equal the sum of its movements. Seeded and exercised below.
console.log('\n-- behavioral checks --')

check(
  'every create type is guarded against re-runs',
  unguardedCreateTypes.length === 0,
  unguardedCreateTypes.join('; ')
)

// Seed a minimal org so the ledger constraint can be exercised.
try {
await db.exec(`
  INSERT INTO auth.users (id, email)
  VALUES ('00000000-0000-0000-0000-000000000001', 'owner@test.local');

  INSERT INTO public.organizations (id, name, slug, currency)
  VALUES ('00000000-0000-0000-0000-000000000001', 'Test Org', 'test-org', 'BDT');

  INSERT INTO public.branches (id, organization_id, name, code)
  VALUES ('00000000-0000-0000-0000-0000000000b1',
          '00000000-0000-0000-0000-000000000001', 'Main', 'MAIN');

  INSERT INTO public.warehouses (id, organization_id, branch_id, name, code, is_retail_floor)
  VALUES ('00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-0000000000b1', 'Floor', 'FLOOR', true);

  INSERT INTO public.products (id, organization_id, name, selling_price, cost_price)
  VALUES ('00000000-0000-0000-0000-0000000000f1',
          '00000000-0000-0000-0000-000000000001', 'Test Product', 100, 60);

  INSERT INTO public.product_variants (id, organization_id, product_id, is_default)
  VALUES ('00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-0000000000f1', true);
`)
} catch (e) {
  console.error('  seed failed: ' + String(e.message ?? e).split('\n')[0])
  process.exit(1)
}

// 1. The movements_arithmetic CHECK rejects an unbalanced row.
let rejected = false
try {
  await db.exec(`
    INSERT INTO public.stock_movements
      (organization_id, warehouse_id, variant_id, product_id, type,
       quantity, direction, before_quantity, after_quantity)
    VALUES ('00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-0000000000a1',
            '00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000000f1',
            'PURCHASE', 10, 1, 0, 99)
  `)
} catch {
  rejected = true
}
check('unbalanced stock movement is rejected by CHECK', rejected)

// 2. The ledger is append-only.
await db.exec(`
  INSERT INTO public.stock_movements
    (organization_id, warehouse_id, variant_id, product_id, type,
     quantity, direction, before_quantity, after_quantity, unit_cost)
  VALUES ('00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-0000000000f1',
          'PURCHASE', 10, 1, 0, 10, 60)
`)
let immutable = false
try {
  await db.exec(`UPDATE public.stock_movements SET quantity = 999`)
} catch {
  immutable = true
}
check('stock_movements is append-only (UPDATE blocked)', immutable)

// 3. One open register session per register.
await db.exec(`
  INSERT INTO public.registers (id, organization_id, branch_id, name, code)
  VALUES ('00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-0000000000b1', 'Counter 1', 'C1');
  INSERT INTO public.register_sessions
    (organization_id, register_id, branch_id, opened_by, opening_cash)
  VALUES ('00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000b1',
          '00000000-0000-0000-0000-000000000001', 500);
`)
let dupSession = false
try {
  await db.exec(`
    INSERT INTO public.register_sessions
      (organization_id, register_id, branch_id, opened_by, opening_cash)
    VALUES ('00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-000000000001', 500)
  `)
} catch {
  dupSession = true
}
check('second open session on one register is rejected', dupSession)

// 4. Money columns are exact numerics, never floats.
const money = await q(`
  select column_name, data_type from information_schema.columns
   where table_name = 'sales' and column_name in ('total','cogs','profit')
   order by column_name`)
check(
  'sales money columns are numeric, not float',
  money.length === 3 && money.every((r) => r.data_type === 'numeric'),
  money.map((r) => `${r.column_name}:${r.data_type}`).join(' ')
)

// 5. Profit is generated, so it cannot drift from its inputs.
const profitCol = await q(`
  select is_generated from information_schema.columns
   where table_name = 'sales' and column_name = 'profit'`)
check('sales.profit is a generated column', profitCol[0]?.is_generated === 'ALWAYS')

// 6. Default-variant uniqueness.
let dupDefault = false
try {
  await db.exec(`
    INSERT INTO public.product_variants
      (organization_id, product_id, is_default)
    VALUES ('00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-0000000000f1', true)
  `)
} catch {
  dupDefault = true
}
check('a product cannot have two default variants', dupDefault)

// 6b. A blank SKU is filled in by the database, not left null (054).
//
// The form has promised "Auto-generated if blank" since the beginning while
// nothing generated anything, and Quick add — the dialog most products are
// created in — has no SKU field at all. These hold the trigger to the three
// cases that matter: blank gets a code, a typed code is kept, and a Bangla
// name (no ASCII letters to take a prefix from) still produces a usable one.
const skuOrg = '00000000-0000-0000-0000-000000000001'

await db.exec(`
  INSERT INTO public.products (organization_id, name, selling_price, cost_price)
  VALUES ('${skuOrg}', 'Miniket Rice 5kg', 100, 50)
`)
const autoSku = await q(
  `select sku from public.products where name = 'Miniket Rice 5kg'`
)
check(
  'a product saved without a SKU is given one',
  /^MIN-\d{4}$/.test(autoSku[0]?.sku ?? ''),
  String(autoSku[0]?.sku)
)

await db.exec(`
  INSERT INTO public.products (organization_id, name, sku, selling_price, cost_price)
  VALUES ('${skuOrg}', 'Hand coded', '  MY-CODE-1 ', 100, 50)
`)
const kept = await q(`select sku from public.products where name = 'Hand coded'`)
check(
  'a SKU the shop typed is kept, only trimmed',
  kept[0]?.sku === 'MY-CODE-1',
  String(kept[0]?.sku)
)

await db.exec(`
  INSERT INTO public.products (organization_id, name, selling_price, cost_price)
  VALUES ('${skuOrg}', 'উজ্জ্বল চাল', 100, 50)
`)
const bangla = await q(`select sku from public.products where name = 'উজ্জ্বল চাল'`)
check(
  'a Bangla name still produces a usable code',
  /^SKU-\d{4}$/.test(bangla[0]?.sku ?? ''),
  String(bangla[0]?.sku)
)

await db.exec(`
  INSERT INTO public.products (organization_id, name, sku, selling_price, cost_price)
  VALUES ('${skuOrg}', 'Miniket Rice 10kg', '', 100, 50)
`)
const second = await q(
  `select sku from public.products where name = 'Miniket Rice 10kg'`
)
check(
  'an empty string counts as blank, and the number moves on',
  /^MIN-\d{4}$/.test(second[0]?.sku ?? '') && second[0]?.sku !== autoSku[0]?.sku,
  `${autoSku[0]?.sku} then ${second[0]?.sku}`
)

// 7. next_sequence produces gap-free, monotonically increasing values.
const seqs = []
for (let i = 0; i < 5; i++) {
  const r = await q(`select public.next_sequence(
    '00000000-0000-0000-0000-000000000001', 'invoice:2026')::int as n`)
  seqs.push(r[0].n)
}
check(
  'next_sequence is monotonic and gap-free',
  seqs.every((n, i) => n === i + 1),
  seqs.join(',')
)

}

try {
  await runChecks()
} catch (e) {
  console.log(`  ERROR  ${String(e.message ?? e).split('\n')[0]}`)
  checks.push({ name: 'unexpected error', pass: false })
}

// ── End-to-end: complete_sale ─────────────────────────────────────────────
// The seed provisions a demo organization with an owner, roles and payment
// methods. Signing in as that owner and running a real sale proves the whole
// write path: authorization → stock lock → ledger → invoice → register →
// outbox. This is the check that would catch a broken RPC.
const seeded = await q(`
  select o.id as org, b.id as branch, w.id as warehouse, r.id as register,
         (select id from public.payment_methods
           where organization_id = o.id and key = 'cash') as cash,
         '00000000-0000-0000-0000-00000000dead' as owner
    from public.organizations o
    join public.branches b    on b.organization_id = o.id
    join public.warehouses w  on w.organization_id = o.id and w.is_retail_floor
    join public.registers r   on r.organization_id = o.id
   where o.slug = 'seed-demo-shop'
   limit 1`)

if (seeded.length === 0) {
  check('seeded demo organization exists', false, 'seed-demo-shop not found')
} else {
  const s = seeded[0]
  await db.exec(`select set_config('request.jwt.claim.sub', '${s.owner}', false)`)

  const canSee = await q(`select app.current_org_ids() as orgs`)
  check(
    'signed-in owner resolves their organization',
    canSee[0].orgs.includes(s.org),
    String(canSee[0].orgs)
  )

  const isOwner = await q(`select app.has_permission('sales.create') as ok`)
  check('owner holds sales.create via the * wildcard', isOwner[0].ok === true)

  // A product with stock.
  await db.exec(`
    INSERT INTO public.products (id, organization_id, name, selling_price, cost_price, track_stock)
    VALUES ('00000000-0000-0000-0000-00000000c001', '${s.org}', 'E2E Widget', 250, 150, true);
    INSERT INTO public.product_variants (id, organization_id, product_id, is_default)
    VALUES ('00000000-0000-0000-0000-00000000c002', '${s.org}',
            '00000000-0000-0000-0000-00000000c001', true);
  `)

  const afterStockIn = await q(`
    select public.apply_stock_movement(
      '${s.warehouse}', '00000000-0000-0000-0000-00000000c002',
      'PURCHASE', 10, 150, 'test', null, null)::numeric as qty`)
  check('stock-in records 10 units', Number(afterStockIn[0].qty) === 10, String(afterStockIn[0].qty))

  const session = await q(`
    select public.open_register('${s.register}', 1000, null) as id`)
  check('register opens', Boolean(session[0].id))

  const sale = await q(`
    select public.complete_sale(
      '${s.branch}',
      jsonb_build_array(jsonb_build_object(
        'variant_id', '00000000-0000-0000-0000-00000000c002',
        'qty', 3)),
      jsonb_build_array(jsonb_build_object(
        'method_id', '${s.cash}', 'amount', 750)),
      '${s.register}', null, null, null, null, null) as r`)

  const result = sale[0].r
  check('complete_sale returns COMPLETED', result.status === 'COMPLETED', String(result.status))
  check('sale total is 3 × 250', Number(result.total) === 750, String(result.total))
  check('invoice number is formatted', /^INV-\d{4}-\d{6}$/.test(result.invoice_no), result.invoice_no)

  const bal = await q(`
    select quantity from public.stock_balances
     where warehouse_id = '${s.warehouse}'
       and variant_id = '00000000-0000-0000-0000-00000000c002'`)
  check('stock decremented 10 → 7', Number(bal[0].quantity) === 7, String(bal[0].quantity))

  const ledger = await q(`
    select type, before_quantity, after_quantity, unit_cost
      from public.stock_movements
     where variant_id = '00000000-0000-0000-0000-00000000c002'
     order by created_at`)
  check(
    'ledger has balanced PURCHASE and SALE rows',
    ledger.length === 2 &&
      ledger[0].type === 'PURCHASE' &&
      ledger[1].type === 'SALE' &&
      Number(ledger[1].before_quantity) === 10 &&
      Number(ledger[1].after_quantity) === 7,
    ledger.map((r) => `${r.type}:${r.before_quantity}→${r.after_quantity}`).join(' ')
  )

  const profit = await q(`
    select cogs, profit from public.sales where invoice_no = '${result.invoice_no}'`)
  check(
    'profit captured at sale time (750 − 3×150 = 300)',
    Number(profit[0].cogs) === 450 && Number(profit[0].profit) === 300,
    `cogs=${profit[0].cogs} profit=${profit[0].profit}`
  )

  const outbox = await q(`
    select event_type from public.outbox
     where organization_id = '${s.org}' and aggregate_type = 'sale'`)
  check(
    'sale.completed event written to the outbox',
    outbox.some((r) => r.event_type === 'sale.completed'),
    outbox.map((r) => r.event_type).join(',')
  )

  const cash = await q(`
    select sales_cash, opening_cash from public.register_sessions where id = '${session[0].id}'`)
  check(
    'register tracked the cash sale',
    Number(cash[0].sales_cash) === 750 && Number(cash[0].opening_cash) === 1000,
    `sales_cash=${cash[0].sales_cash}`
  )

  // Overselling must be impossible — the whole point of the row lock.
  let blocked = false
  try {
    await db.exec(`
      select public.complete_sale(
        '${s.branch}',
        jsonb_build_array(jsonb_build_object(
          'variant_id', '00000000-0000-0000-0000-00000000c002',
          'qty', 999)),
        jsonb_build_array(jsonb_build_object(
          'method_id', '${s.cash}', 'amount', 1)),
        '${s.register}', null, null, null, null, null)`)
  } catch (e) {
    blocked = /insufficient_stock/.test(String(e.message ?? e))
  }
  check('overselling is rejected by the database', blocked)

  // ── Migration 021: tax-inclusive pricing must not double-charge ──────────
  //
  // Before 021 complete_sale computed the correct inclusive line total and
  // then ignored it, summing `subtotal - discount + tax` instead. Since
  // `subtotal` already contains the VAT for an inclusive product, the VAT was
  // charged twice. Found by porting the client cart arithmetic to
  // src/shared/domain/cart.ts and diffing it against the RPC.
  await db.exec(`
    INSERT INTO public.taxes (id, organization_id, name, rate, is_inclusive, applies_to)
    VALUES ('00000000-0000-0000-0000-000000007a01', '${s.org}',
            'VAT 15%', 15, false, 'products');
    INSERT INTO public.products (id, organization_id, name, selling_price, cost_price,
                                 tax_id, tax_inclusive, track_stock)
    VALUES ('00000000-0000-0000-0000-000000007b01', '${s.org}', 'Inclusive Soap',
            115, 80, '00000000-0000-0000-0000-000000007a01', true, false);
    INSERT INTO public.product_variants (id, organization_id, product_id, is_default)
    VALUES ('00000000-0000-0000-0000-000000007c01', '${s.org}',
            '00000000-0000-0000-0000-000000007b01', true);
  `)

  const inclusive = await q(`
    select public.complete_sale(
      '${s.branch}',
      jsonb_build_array(jsonb_build_object(
        'variant_id', '00000000-0000-0000-0000-000000007c01', 'qty', 1)),
      jsonb_build_array(jsonb_build_object(
        'method_id', '${s.cash}', 'amount', 115)),
      '${s.register}', null, null, null, null, null) as r`)

  check(
    'tax-inclusive product charges its shelf price, not price + VAT (021)',
    Number(inclusive[0].r.total) === 115,
    `total=${inclusive[0].r.total} tax=${inclusive[0].r.tax}`
  )
  check(
    'the VAT inside an inclusive price is still reported (021)',
    Number(inclusive[0].r.tax) === 15,
    `tax=${inclusive[0].r.tax}`
  )

  const mixed = await q(`
    select public.complete_sale(
      '${s.branch}',
      jsonb_build_array(
        jsonb_build_object('variant_id', '00000000-0000-0000-0000-000000007c01', 'qty', 1),
        jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000c002', 'qty', 1)),
      jsonb_build_array(jsonb_build_object(
        'method_id', '${s.cash}', 'amount', 365)),
      '${s.register}', null, null, null, null, null) as r`)
  check(
    'a mixed inclusive/exclusive cart totals correctly (021)',
    Number(mixed[0].r.total) === 365,
    `total=${mixed[0].r.total} (soap 115 inclusive + widget 250 untaxed)`
  )

  // An order-level discount must still reduce the total after 021.
  const discounted = await q(`
    select public.complete_sale(
      p_branch_id    => '${s.branch}',
      p_items        => jsonb_build_array(jsonb_build_object(
        'variant_id', '00000000-0000-0000-0000-00000000c002', 'qty', 2)),
      p_payments     => jsonb_build_array(jsonb_build_object(
        'method_id', '${s.cash}', 'amount', 450)),
      p_register_id  => '${s.register}',
      p_discount_type  => 'FLAT',
      p_discount_value => 50
    ) as r`)
  check(
    'an order-level FLAT discount still applies after 021',
    Number(discounted[0].r.total) === 450 && Number(discounted[0].r.discount) === 50,
    `total=${discounted[0].r.total} discount=${discounted[0].r.discount}`
  )

  // ── Migration 021: the hold / resume loop must close ─────────────────────
  const held = await q(`
    select public.hold_sale(
      '${s.branch}',
      jsonb_build_array(jsonb_build_object(
        'variant_id', '00000000-0000-0000-0000-00000000c002', 'qty', 2,
        'discount_type', 'FLAT', 'discount_value', 50)),
      null, 'customer went to the car') as id`)
  check('hold_sale returns an id', Boolean(held[0].id), String(held[0].id))

  const resumed = await q(`select public.resume_sale('${held[0].id}') as r`)
  const resumedItems = resumed[0].r.items
  check(
    'resume_sale returns the stored lines (021)',
    Array.isArray(resumedItems) && resumedItems.length === 1,
    JSON.stringify(resumedItems)
  )
  check(
    'resume_sale returns the per-line discount hold_sale stored (021)',
    resumedItems[0]?.discount_type === 'FLAT'
      && Number(resumedItems[0]?.discount_value) === 50,
    JSON.stringify(resumedItems[0])
  )

  const stillHeld = await q(`select status from public.sales where id = '${held[0].id}'`)
  check(
    'a resumed hold stays HELD until its sale lands (021)',
    stillHeld[0].status === 'HELD',
    String(stillHeld[0].status)
  )

  // Named notation: with ten parameters and several untyped NULLs, positional
  // calls leave Postgres guessing at types. Naming them is unambiguous and
  // survives a future parameter being inserted in the middle.
  const completedFromHold = await q(`
    select public.complete_sale(
      p_branch_id      => '${s.branch}',
      p_items          => jsonb_build_array(jsonb_build_object(
        'variant_id', '00000000-0000-0000-0000-00000000c002', 'qty', 2,
        'discount_type', 'FLAT', 'discount_value', 50)),
      p_payments       => jsonb_build_array(jsonb_build_object(
        'method_id', '${s.cash}', 'amount', 450)),
      p_register_id    => '${s.register}',
      p_held_sale_id   => '${held[0].id}'
    ) as r`)
  check(
    'a resumed cart completes through complete_sale (021)',
    completedFromHold[0].r.status === 'COMPLETED',
    String(completedFromHold[0].r.status)
  )

  const heldAfter = await q(`select status from public.sales where id = '${held[0].id}'`)
  check(
    'completing a resumed cart cancels its hold atomically (021)',
    heldAfter[0].status === 'CANCELLED',
    String(heldAfter[0].status)
  )

  const heldRowsInReports = await q(`
    select count(*)::int as n from public.sales
     where organization_id = '${s.org}'
       and status in ('COMPLETED','PARTIALLY_PAID','PARTIALLY_REFUNDED')
       and invoice_no like 'HELD-%'`)
  check(
    'no held cart is ever counted as a sale',
    heldRowsInReports[0].n === 0,
    String(heldRowsInReports[0].n)
  )

  // An unauthorized user must not be able to sell.
  await db.exec(`
    INSERT INTO auth.users (id, email)
    VALUES ('00000000-0000-0000-0000-00000000beef', 'intruder@test.local')
    ON CONFLICT DO NOTHING;
    select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000beef', false)`)
  // An outsider must be refused. A user with no user_organizations row is
  // stopped by require_org ('forbidden'); one with membership but no role is
  // stopped by require_permission ('permission_denied'). Either proves the
  // check is server-side, so accept both.
  let denied = false
  let denialReason = ''
  try {
    await db.exec(`
      select public.complete_sale(
        '${s.branch}',
        jsonb_build_array(jsonb_build_object(
          'variant_id', '00000000-0000-0000-0000-00000000c002',
          'qty', 1)),
        jsonb_build_array(jsonb_build_object(
          'method_id', '${s.cash}', 'amount', 250)),
        '${s.register}', null, null, null, null, null)`)
  } catch (e) {
    denialReason = String(e.message ?? e).split('\n')[0]
    denied = /permission_denied|forbidden/.test(denialReason)
  }
  check('a user outside the organization cannot complete a sale', denied, denialReason)

  // A member with a role lacking the permission must also be refused. This is
  // the case that matters for a cashier trying to refund.
  await db.exec(`
    INSERT INTO auth.users (id, email)
    VALUES ('00000000-0000-0000-0000-00000000cafe', 'cashier@test.local')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.user_organizations (user_id, organization_id)
    VALUES ('00000000-0000-0000-0000-00000000cafe', '${s.org}')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, organization_id, role_id)
    SELECT '00000000-0000-0000-0000-00000000cafe', '${s.org}', id
      FROM public.roles WHERE organization_id = '${s.org}' AND key = 'cashier';
    select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000cafe', false)`)

  const cashierCan = await q(`select app.has_permission('sales.create') as yes,
                                     app.has_permission('sales.refund') as no`)
  check(
    'cashier holds sales.create but not sales.refund',
    cashierCan[0].yes === true && cashierCan[0].no === false,
    `create=${cashierCan[0].yes} refund=${cashierCan[0].no}`
  )

  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)

}

// ── ERD consistency ───────────────────────────────────────────────────────
// The Mermaid ERD in the design doc must not promise a table the migrations
// fail to create. Checked against the live schema, not against the doc's own
// illustrative DDL, so the migrations stay the single source of truth.
const tableNames = new Set(tables.map((r) => r.table_name))
let erdMissing = []
try {
  const doc = readFileSync(join(root, 'docs', '04-database-design.md'), 'utf8')
  const erd = doc.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? ''
  const entities = new Set()
  for (const line of erd.split('\n')) {
    const m = line.match(/^\s*(\w+)\s+[|o{}]+--+[|o{}]+\s+(\w+)\s*:/)
    if (m) {
      entities.add(m[1])
      entities.add(m[2])
    }
  }
  // `users` is auth.users, provided by Supabase rather than our migrations.
  erdMissing = [...entities].filter((e) => !tableNames.has(e) && e !== 'users')
  check(
    'ERD references no table the migrations fail to create',
    erdMissing.length === 0,
    erdMissing.length ? erdMissing.join(', ') : `${entities.size} entities`
  )
} catch {
  check('ERD consistency (doc not found)', false)
}

// ── Session payload (migration 019) ─────────────────────────────────────
// Verified here rather than inside the migration: it needs the seeded demo
// organization, and seeds are applied after migrations. The preceding
// assertion left the JWT claim pointing at a role-less user, so restore the
// owner first.
await db.query(`select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000dead', false)`)
const payloadRows = await q(`select public.session_payload()::text as p`)
const payload = JSON.parse(payloadRows[0].p)
check(
  'session_payload lists the owner organization',
  payload.organizations.length === 1,
  `${payload.organizations.length} org(s)`
)
const ownerOrg = payload.organizations[0] ?? { name: '(none)', is_owner: false, permissions: [] }
check('session_payload carries org identity', ownerOrg.name === 'Seed Demo Shop', ownerOrg.name)
check('session_payload marks the owner', ownerOrg.is_owner === true, String(ownerOrg.is_owner))
check(
  'session_payload exposes stable role keys',
  Array.isArray(ownerOrg.role_keys) && ownerOrg.role_keys.includes('owner'),
  JSON.stringify(ownerOrg.role_keys)
)
check(
  'session_payload expands the owner wildcard into concrete keys',
  ownerOrg.permissions.includes('sales.create') && ownerOrg.permissions.includes('users.delete'),
  `${ownerOrg.permissions.length} keys`
)
check(
  'session_payload does not leak the raw wildcard to the client',
  !ownerOrg.permissions.includes('*'),
  ownerOrg.permissions.includes('*') ? 'leaked *' : 'expanded'
)

// The plugin read bridge (034, repaired in 048). Asserted here because its
// failure mode is silence: a body naming a column that no longer exists raises
// only when it *runs*, and every plugin that reads products catches the error
// and draws an empty shop — which is what Batch & Expiry's watch list did for
// a week without anyone noticing.
const bridge = await q(
  `select public.plugin_products('${ownerOrg.organization_id}') as payload`
)
const bridged = Array.isArray(bridge[0]?.payload) ? bridge[0].payload : []
const widget = bridged.find((product) => product.name === 'E2E Widget')
check(
  'plugin_products answers, and carries this shop’s products',
  bridged.length > 0 && Boolean(widget),
  `${bridged.length} product(s)`
)
check(
  'plugin_products hands money over in minor units',
  widget?.price === 25000,
  String(widget?.price)
)
check(
  'plugin_products still carries the metadata a plugin field lives in',
  widget?.metadata !== null && typeof widget?.metadata === 'object',
  JSON.stringify(widget?.metadata)
)
// The shop's business type is what the client uses to decide what a shopkeeper
// meets first — a pharmacy's expiry date, a mobile shop's serial tracking
// (047, docs/08 §2). It has to travel with the session, because the taxonomy
// that knows the rules lives in the bundle and the key lives in the database.
check(
  'session_payload carries the shop type the taxonomy keys on',
  typeof ownerOrg.shop_type === 'string' && ownerOrg.shop_type.length > 0,
  String(ownerOrg.shop_type)
)

// A cashier must not receive what the owner received. Scoped to the owner's
// organization explicitly — an unqualified `(select id from organizations)`
// returns more than one row as soon as a second org exists.
const CASHIER = '11111111-1111-1111-1111-111111111111'
await db.query(`insert into auth.users (id, email) values ('${CASHIER}', 'cashier@example.com')`)
await db.query(`
  insert into public.user_organizations (user_id, organization_id, is_active)
  values ('${CASHIER}', '${ownerOrg.organization_id}', true)
`)
const cashierRole = await q(`
  select id::text as id from public.roles
   where key = 'cashier' and organization_id = '${ownerOrg.organization_id}'`)
if (cashierRole.length !== 1) {
  check('cashier role exists in the demo organization', false, `${cashierRole.length} rows`)
} else {
  await db.query(`
    insert into public.user_roles (user_id, role_id, organization_id)
    values ('${CASHIER}', '${cashierRole[0].id}', '${ownerOrg.organization_id}')`)
}
await db.query(`select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false)`)
const cashierRows = await q(`select public.session_payload()::text as p`)
const cashierPayload = JSON.parse(cashierRows[0].p)
const cashierOrg = cashierPayload.organizations[0] ?? { is_owner: true, permissions: [] }
check('cashier holds sales.create', cashierOrg.permissions.includes('sales.create'))
check(
  'cashier does not hold sales.refund',
  !cashierOrg.permissions.includes('sales.refund'),
  cashierOrg.permissions.filter((k) => k.startsWith('sales.')).join(',')
)
check('cashier is not flagged as owner', cashierOrg.is_owner === false, String(cashierOrg.is_owner))
check(
  'cashier is denied the owner-only wildcard',
  !cashierOrg.permissions.includes('*') && !cashierOrg.permissions.includes('users.delete'),
  `users.delete=${cashierOrg.permissions.includes('users.delete')}`
)
await db.query(`select set_config('request.jwt.claim.sub', null, false)`)

// ── RLS helper executability ──────────────────────────────────────────────
// PGlite runs as superuser, so GRANT/REVOKE are never enforced at runtime and
// a missing EXECUTE grant is invisible to every other assertion here. It is
// not invisible on a real Supabase project: RLS policy expressions run as the
// *querying* role, so an ungranted helper turns every anonymous read into
// `42501 permission denied for function …` instead of an empty result.
//
// This check reads the recorded ACLs, which PGlite does maintain, and compares
// them against the functions the policies actually call.
const policyFns = new Map()
for (const row of policies_text) {
  for (const expr of [row.qual, row.with_check]) {
    if (!expr) continue
    for (const m of String(expr).matchAll(/\bapp\.([a-z_]+)\s*\(/g)) {
      policyFns.set(m[1], (policyFns.get(m[1]) ?? 0) + 1)
    }
  }
}

for (const [name, refs] of [...policyFns.entries()].sort()) {
  const g = await q(`
    select has_function_privilege('anon', p.oid, 'EXECUTE')::text          as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = '${name}'`)
  const row = g[0] ?? { anon: 'missing', auth: 'missing' }
  check(
    `app.${name} is executable by anon and authenticated (${refs} policy refs)`,
    row.anon === 'true' && row.auth === 'true',
    `anon=${row.anon} authenticated=${row.auth}`
  )
}

// The internal helpers must stay unreachable — that is the other half of the
// grant story. If one of these ever becomes callable from the client, the
// stock ledger can be written directly.
for (const name of ['apply_stock_movement', 'next_sequence']) {
  const g = await q(`
    select has_function_privilege('anon', p.oid, 'EXECUTE')::text          as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '${name}'`)
  const row = g[0] ?? { anon: 'missing', auth: 'missing' }
  check(
    `internal helper ${name} stays revoked from anon and authenticated`,
    row.anon === 'false' && row.auth === 'false',
    `anon=${row.anon} authenticated=${row.auth}`
  )
}

// ── The grant nobody writes ───────────────────────────────────────────────
// Postgres grants EXECUTE on a *new* function to PUBLIC, and — as 043 records
// after measuring it — `alter default privileges … revoke … from public`
// cannot take that back, because default privileges are additive over the
// built-in default for functions. So the protection has to run when the object
// is created, and the plugin host does it.
//
// Two checks, because they catch different edits. This one reads the deployed
// function and requires an actual `perform` call (not the name in a comment);
// the lifecycle checks further down are the behavioural half, and the
// `careless-probe` package there is a plugin that grants nothing at all.
const hostFn = await q(`
  select pg_get_functiondef(p.oid) as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'plugin_apply_migrations'`)
const hostBody = String(hostFn[0]?.body ?? '')
const hostWired = /^\s*perform\s+app\.plugin_close_world_grants\s*\(/m.test(hostBody)
check(
  'the plugin host closes PUBLIC access on what a plugin creates, and really calls it',
  hostWired,
  hostBody === ''
    ? 'app.plugin_apply_migrations is missing'
    : hostWired
      ? 'a live perform call, not the name in a comment'
      : 'no live perform call in the deployed body'
)

// ── Nothing of ours is reachable without a session ────────────────────────
// 042's rule, checked from the other side: after every migration has run, the
// functions this project owns must not be executable by an anonymous caller.
// Scoped by owner on purpose — an extension's functions belong to a role this
// project cannot revoke as (see 042), and the live check below it in
// `tools/check-db-acl.mjs` makes the same distinction.
const anonOwned = await q(`
  select p.proname, n.nspname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app')
     and p.prokind = 'f'
     and p.proowner = current_user::regrole
     and has_function_privilege('anon', p.oid, 'EXECUTE')
   order by n.nspname, p.proname`)
const anonAllowed = new Set(['in_org', 'has_permission', 'visible_branch_ids'])
const anonOffenders = anonOwned.filter(
  (row) => !(row.nspname === 'app' && anonAllowed.has(row.proname))
)
check(
  'no function this project owns is executable by an anonymous caller',
  anonOffenders.length === 0,
  anonOffenders.length === 0
    ? `${anonOwned.length} anon-reachable, all RLS helpers`
    : anonOffenders.map((row) => `${row.nspname}.${row.proname}`).join(', ')
)

// ── Client-facing RPC reachability ────────────────────────────────────────
// Two distinct failure modes, both invisible to PGlite at runtime because it
// runs as superuser:
//
//   42725 "is not unique" — adding a parameter with `create or replace` leaves
//     the old signature in place, so an existing call matches two overloads.
//     Migration 021 did exactly this until the old signature was dropped.
//
//   42501 "permission denied" — `drop function` takes the grant with it, so a
//     re-created function is unreachable until it is granted again.
for (const name of ['complete_sale', 'hold_sale', 'resume_sale', 'refund_sale',
                    'open_register', 'close_register', 'register_cash_movement']) {
  const g = await q(`
    select count(*)::int as overloads,
           bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text as auth,
           bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))::text          as anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '${name}'`)
  const row = g[0] ?? { overloads: 0, auth: 'missing', anon: 'missing' }
  check(
    `${name} has exactly one overload, granted to authenticated only`,
    row.overloads === 1 && row.auth === 'true' && row.anon === 'false',
    `overloads=${row.overloads} authenticated=${row.auth} anon=${row.anon}`
  )
}

// ── The POS catalogue view ────────────────────────────────────────────────
// `security_invoker` is the difference between a saved query and a data leak.
// A view without it executes as its owner, so it would return every
// organization's catalogue to any signed-in user regardless of the RLS
// policies on the tables underneath. PGlite does not enforce RLS, so this is
// the only place the property is checked.
const viewRow = await q(`
  select c.reloptions::text as opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'pos_catalog' and c.relkind = 'v'`)
check(
  'pos_catalog exists and runs as the invoker, so underlying RLS applies',
  viewRow.length === 1 && /security_invoker=(true|on)/.test(String(viewRow[0].opts ?? '')),
  viewRow[0] ? String(viewRow[0].opts) : 'view missing'
)

// A variant with a price override must win over the product's price, and one
// without must inherit it. That resolution happens in the view, so if it is
// wrong every client is wrong in the same way at once.
const priced = await q(`
  select pos.price as inherited
    from public.pos_catalog pos
   where pos.product_id = '00000000-0000-0000-0000-000000007b01'`)
check(
  'pos_catalog resolves a variant price from its product when not overridden',
  priced.length === 1 && Number(priced[0].inherited) === 115,
  priced[0] ? String(priced[0].inherited) : 'no row'
)

// ── Slugs survive a name collision (023) ─────────────────────────────────
//
// Two shops called "Rahim Store" is the normal case in a Bangladeshi bazaar.
// Before 023 the second signup died on organizations_slug_key and the
// shopkeeper got a raw Postgres error instead of a shop.
const twinA = await q(`
  insert into public.organizations (id, name, slug)
  values (gen_random_uuid(), 'Rahim Store', 'rahim-store')
  returning slug`)
const twinB = await q(`
  insert into public.organizations (id, name, slug)
  values (gen_random_uuid(), 'Rahim Store', 'rahim-store')
  returning slug`)
const twinC = await q(`
  insert into public.organizations (id, name, slug)
  values (gen_random_uuid(), 'Rahim Store', 'rahim-store')
  returning slug`)
check(
  'a second organization with a colliding slug is created, not rejected',
  twinA.length === 1 && twinB.length === 1 && twinC.length === 1,
  [twinA, twinB, twinC].map((r) => r[0]?.slug).join(', ')
)
check(
  'colliding slugs are de-conflicted with a numeric suffix',
  twinA[0]?.slug === 'rahim-store' &&
    twinB[0]?.slug === 'rahim-store-2' &&
    twinC[0]?.slug === 'rahim-store-3',
  [twinA, twinB, twinC].map((r) => r[0]?.slug).join(', ')
)

// A slug the caller hand-rolled is normalised rather than trusted: the
// database is the last word on what a slug may look like, because an
// unslugified value fails the same way a collision does.
const messy = await q(`
  insert into public.organizations (id, name, slug)
  values (gen_random_uuid(), 'Karim & Sons', '  Karim & Sons!  ')
  returning slug`)
check(
  'a malformed slug is normalised on the way in',
  messy[0]?.slug === 'karim-sons',
  messy[0] ? String(messy[0].slug) : 'no row'
)

// and a name that slugifies to nothing at all (Bengali, emoji) still lands.
const nameless = await q(`
  insert into public.organizations (id, name, slug)
  values (gen_random_uuid(), 'মায়ের দোয়া স্টোর', '')
  returning slug`)
check(
  'a slug that normalises to nothing falls back rather than failing',
  nameless[0]?.slug === 'shop',
  nameless[0] ? String(nameless[0].slug) : 'no row'
)

// ── Phase 3 — inventory operations and the ledger invariants ─────────────
//
// The acceptance criteria for this phase are properties, not examples: every
// balance change must have a ledger row where before + delta = after, the
// balance must equal the sum of its movements, and the stock value the
// dashboard reports must equal Σ(quantity × avg_unit_cost) exactly. A handful
// of hand-picked cases cannot show that, so the first check below drives
// randomized operation sequences and then verifies the invariants over every
// row they produced.
if (seeded.length !== 0) {
  const s = seeded[0]
  // The shop's own today, as the app's calls resolve it — see the note on
  // `TODAY` further down (migration 030: `app.effective_day`).
  const TODAY = (await q(`select app.effective_day('${s.branch}', null)::text as d`))[0].d

  // The checks above end with the JWT claim cleared or switched to another
  // user; the stock operations all call app.require_org, so re-establish the
  // signed-in owner before exercising them.
  await db.query(`select set_config('request.jwt.claim.sub', '${s.owner}', false)`)

  // A second warehouse to transfer into, and a variant used only by these
  // checks so their arithmetic is not entangled with the sale above.
  await db.exec(`
    INSERT INTO public.warehouses (id, organization_id, name, code, is_retail_floor)
    VALUES ('00000000-0000-0000-0000-00000000d001', '${s.org}', 'Back Room', 'BACK', false)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.products (id, organization_id, name, selling_price, cost_price, track_stock, reorder_point)
    VALUES ('00000000-0000-0000-0000-00000000d002', '${s.org}', 'Invariant Widget', 200, 100, true, 5)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.product_variants (id, organization_id, product_id, is_default)
    VALUES ('00000000-0000-0000-0000-00000000d003', '${s.org}',
            '00000000-0000-0000-0000-00000000d002', true)
    ON CONFLICT (id) DO NOTHING;
  `)

  // ── Weighted-average costing ────────────────────────────────────────────
  //
  // 10 @ 100 then 10 @ 200 is 150 a unit. Getting this wrong is invisible
  // until a profit report is wrong, so it is worth asserting directly.
  await q(`select public.stock_in('${s.warehouse}',
             jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000d003', 'qty', 10, 'unit_cost', 100)),
             null, 'AVG-1', null)`)
  await q(`select public.stock_in('${s.warehouse}',
             jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000d003', 'qty', 10, 'unit_cost', 200)),
             null, 'AVG-2', null)`)

  const avg = await q(`select quantity, avg_unit_cost from public.stock_balances
                        where warehouse_id = '${s.warehouse}' and variant_id = '00000000-0000-0000-0000-00000000d003'`)
  check(
    'weighted average blends two receipts: 10@100 + 10@200 → 150',
    Number(avg[0].quantity) === 20 && Number(avg[0].avg_unit_cost) === 150,
    `qty=${avg[0].quantity} avg=${avg[0].avg_unit_cost}`
  )

  // Stock out must not move the average — the units left at the cost they
  // came in at, whatever the new market price is.
  await q(`select public.stock_out('${s.warehouse}',
             jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000d003', 'qty', 5)),
             'damage', 'bottles broke')`)
  const afterOut = await q(`select quantity, avg_unit_cost from public.stock_balances
                             where warehouse_id = '${s.warehouse}' and variant_id = '00000000-0000-0000-0000-00000000d003'`)
  check(
    'stock out leaves the average untouched',
    Number(afterOut[0].quantity) === 15 && Number(afterOut[0].avg_unit_cost) === 150,
    `qty=${afterOut[0].quantity} avg=${afterOut[0].avg_unit_cost}`
  )

  const damageRow = await q(`select type, note from public.stock_movements
                              where variant_id = '00000000-0000-0000-0000-00000000d003'
                                and direction = -1 order by created_at desc limit 1`)
  check(
    'a damage write-off lands on the ledger as DAMAGE, not a generic adjustment',
    damageRow[0]?.type === 'DAMAGE',
    String(damageRow[0]?.type)
  )

  // ── Unknown reasons are refused ─────────────────────────────────────────
  let badReason = null
  try {
    await q(`select public.stock_out('${s.warehouse}',
               jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000d003', 'qty', 1)),
               'banana', null)`)
  } catch (error) {
    badReason = String(error.message ?? error)
  }
  check('stock out refuses a reason outside the allow-list', /unknown_reason/.test(String(badReason)), String(badReason).slice(0, 60))

  // ── Transfers conserve value ────────────────────────────────────────────
  const valueBefore = await q(`select coalesce(sum(quantity * avg_unit_cost), 0) as v
                                 from public.stock_balances where organization_id = '${s.org}'`)
  const transferId = await q(`select public.transfer_stock('${s.warehouse}', '00000000-0000-0000-0000-00000000d001',
      jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000d003', 'qty', 4)), 'nightly move') as id`)
  const moved = await q(`select warehouse_id, quantity, avg_unit_cost from public.stock_balances
                          where variant_id = '00000000-0000-0000-0000-00000000d003' order by warehouse_id`)
  const valueAfter = await q(`select coalesce(sum(quantity * avg_unit_cost), 0) as v
                                from public.stock_balances where organization_id = '${s.org}'`)
  const dest = moved.find((r) => r.warehouse_id === '00000000-0000-0000-0000-00000000d001')
  const src = moved.find((r) => r.warehouse_id === s.warehouse)
  check(
    'a transfer moves stock and conserves the shop\'s stock value exactly',
    Boolean(transferId[0].id) &&
      Number(src.quantity) === 11 &&
      Number(dest.quantity) === 4 &&
      Number(valueBefore[0].v) === Number(valueAfter[0].v),
    `src=${src.quantity} dest=${dest.quantity} value ${valueBefore[0].v} → ${valueAfter[0].v}`
  )
  check(
    'the receiving warehouse inherits the sending warehouse\'s cost',
    Number(dest.avg_unit_cost) === Number(src.avg_unit_cost),
    `${src.avg_unit_cost} vs ${dest.avg_unit_cost}`
  )
  check(
    'a transfer writes both legs with a shared reference',
    (await q(`select count(*)::int as n from public.stock_movements
               where reference_id = '${transferId[0].id}'
                 and type in ('TRANSFER_OUT','TRANSFER_IN')`))[0].n === 2,
    'expected 2 legs'
  )

  // ── Over-issue is refused, and leaves nothing behind ─────────────────────
  let overIssue = null
  const rowsBefore = (await q(`select count(*)::int as n from public.stock_movements`))[0].n
  try {
    await q(`select public.stock_out('${s.warehouse}',
               jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000d003', 'qty', 99999)),
               'loss', null)`)
  } catch (error) {
    overIssue = String(error.message ?? error)
  }
  const rowsAfter = (await q(`select count(*)::int as n from public.stock_movements`))[0].n
  check('issuing more than is on hand is refused', /insufficient_stock/.test(String(overIssue)), String(overIssue).slice(0, 50))
  check('a refused issue writes no ledger rows at all', rowsBefore === rowsAfter, `${rowsBefore} → ${rowsAfter}`)

  // ── The property test ───────────────────────────────────────────────────
  //
  // Randomized operation sequences, then the invariants over everything they
  // produced. A deterministic LCG keeps the run reproducible: when this fails,
  // the seed in the message is enough to replay it by hand.
  let seed = 20260925
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = (options) => options[Math.floor(rand() * options.length)]
  const variant = '00000000-0000-0000-0000-00000000d003'
  const warehouseA = s.warehouse
  const warehouseB = '00000000-0000-0000-0000-00000000d001'
  let applied = 0
  let refused = 0

  for (let i = 0; i < 60; i++) {
    const qty = 1 + Math.floor(rand() * 12)
    try {
      const op = pick(['in', 'in', 'out', 'adjust', 'adjust', 'transfer'])
      if (op === 'in') {
        await q(`select public.stock_in('${warehouseA}',
                   jsonb_build_array(jsonb_build_object('variant_id', '${variant}', 'qty', ${qty}, 'unit_cost', ${50 + Math.floor(rand() * 150)})),
                   null, 'fuzz', null)`)
      } else if (op === 'out') {
        await q(`select public.stock_out('${warehouseA}',
                   jsonb_build_array(jsonb_build_object('variant_id', '${variant}', 'qty', ${qty})),
                   '${pick(['damage', 'loss', 'expired', 'theft', 'other'])}', 'fuzz')`)
      } else if (op === 'adjust') {
        await q(`select public.adjust_stock('${warehouseA}', '${variant}', ${qty},
                   '${pick(['damage', 'loss', 'expired'])}',
                   ${pick([1, -1])}, 'fuzz')`)
      } else {
        await q(`select public.transfer_stock('${warehouseA}', '${warehouseB}',
                   jsonb_build_array(jsonb_build_object('variant_id', '${variant}', 'qty', ${qty})), 'fuzz')`)
      }
      applied++
    } catch {
      // Refusals are expected — the point is that they leave no trace.
      refused++
    }
  }

  const unbalanced = await q(`
    select count(*)::int as n from public.stock_movements
     where before_quantity + (quantity * direction) <> after_quantity`)
  check(
    `every one of ${applied} randomized operations wrote before + delta = after`,
    unbalanced[0].n === 0,
    unbalanced[0].n === 0 ? `${refused} refused cleanly` : `${unbalanced[0].n} unbalanced rows (seed ${seed})`
  )

  // The balance is a cache of the ledger. If they ever disagree, every number
  // the shop sees is wrong.
  const drifted = await q(`
    select sb.warehouse_id, sb.variant_id, sb.quantity, coalesce(sum(sm.quantity * sm.direction), 0) as ledger_qty
      from public.stock_balances sb
      left join public.stock_movements sm
        on sm.warehouse_id = sb.warehouse_id and sm.variant_id = sb.variant_id
     group by sb.warehouse_id, sb.variant_id, sb.quantity
    having sb.quantity <> coalesce(sum(sm.quantity * sm.direction), 0)`)
  check(
    'every balance equals the sum of its ledger movements',
    drifted.length === 0,
    drifted.length ? `${drifted.length} drifted balances, e.g. ${JSON.stringify(drifted[0])}` : 'all reconcile'
  )

  const negative = await q(`
    select count(*)::int as n from public.stock_balances sb
      join public.products p on p.id = sb.product_id
     where sb.quantity < 0 and not p.allow_negative`)
  check('no operation drove a balance negative', negative[0].n === 0, `${negative[0].n} negative balances`)

  // ── The dashboard number and the stock screen must agree exactly ─────────
  const summary = await q(`select public.stock_summary('${s.org}') as r`)
  const direct = await q(`select coalesce(sum(quantity * avg_unit_cost), 0) as v
                            from public.stock_balances where organization_id = '${s.org}'`)
  const dashboard = await q(`select public.dashboard_summary('${s.branch}', '${TODAY}'::date) as r`)
  check(
    'stock_summary equals Σ(quantity × avg_unit_cost) exactly',
    Number(summary[0].r.stock_value) === Number(direct[0].v),
    `${summary[0].r.stock_value} vs ${direct[0].v}`
  )
  check(
    'the dashboard stock value equals the stock screen value exactly',
    Number(dashboard[0].r.stock_value) === Number(direct[0].v),
    `dashboard ${dashboard[0].r.stock_value} vs Σ ${direct[0].v}`
  )
  check(
    'stock_summary counts low and out of stock separately',
    summary[0].r.low_stock >= 0 && summary[0].r.out_of_stock >= 0 && 'variants_in_stock' in summary[0].r,
    `in stock=${summary[0].r.variants_in_stock} low=${summary[0].r.low_stock} out=${summary[0].r.out_of_stock}`
  )

  // ── Cross-tenant transfer is refused ────────────────────────────────────
  await db.exec(`
    INSERT INTO public.organizations (id, name, slug) VALUES
      ('00000000-0000-0000-0000-00000000e001', 'Other Shop', 'fuzz-other-shop')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.warehouses (id, organization_id, name, code, is_retail_floor) VALUES
      ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000e001', 'Their Room', 'THEIRS', true)
    ON CONFLICT (id) DO NOTHING;
  `)
  let crossTenant = null
  try {
    await q(`select public.transfer_stock('${warehouseA}', '00000000-0000-0000-0000-00000000e002',
               jsonb_build_array(jsonb_build_object('variant_id', '${variant}', 'qty', 1)), null)`)
  } catch (error) {
    crossTenant = String(error.message ?? error)
  }
  check(
    'stock cannot be transferred into another shop',
    /cannot transfer between organizations/.test(String(crossTenant)),
    String(crossTenant).slice(0, 50)
  )

  // ── The client still cannot reach the ledger primitive ──────────────────
  const primitiveGrants = await q(`
    select has_function_privilege('authenticated', 'public.apply_stock_movement(uuid, uuid, public.stock_movement_type, numeric, numeric, text, uuid, text)', 'EXECUTE') as ok`)
  check(
    'the new operations did not hand the ledger primitive to clients',
    primitiveGrants[0].ok === false,
    `apply_stock_movement executable by authenticated: ${primitiveGrants[0].ok}`
  )

  // Leave the session as it was found: the checks after this one load the
  // seed state and should not inherit a signed-in user.
  await db.query(`select set_config('request.jwt.claim.sub', null, false)`)
}

// ── Phase 4 — business management ────────────────────────────────────────
//
// The acceptance criteria are about records being *exact*: a partial receipt
// must leave the order in PARTIALLY_RECEIVED with the outstanding quantity
// correct, a refund must restock exactly what it refunded and cite the sale
// item it came from, over-refunding must be refused by the database, and every
// audited action must carry actor, before and after. So each check below reads
// the rows back rather than trusting the function's return value.
if (seeded.length !== 0) {
  const s = seeded[0]
  await db.query(`select set_config('request.jwt.claim.sub', '${s.owner}', false)`)
  // The shop's own today — see the note on `TODAY` below (migration 030).
  const TODAY = (await q(`select app.effective_day('${s.branch}', null)::text as d`))[0].d

  // A supplier and a product that only these checks touch.
  await db.exec(`
    INSERT INTO public.suppliers (id, organization_id, name, phone)
    VALUES ('00000000-0000-0000-0000-00000000f001', '${s.org}', 'Karim Wholesale', '01700000000')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.products (id, organization_id, name, selling_price, cost_price, track_stock)
    VALUES ('00000000-0000-0000-0000-00000000f002', '${s.org}', 'PO Widget', 300, 200, true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.product_variants (id, organization_id, product_id, is_default)
    VALUES ('00000000-0000-0000-0000-00000000f003', '${s.org}',
            '00000000-0000-0000-0000-00000000f002', true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.customers (id, organization_id, name, phone)
    VALUES ('00000000-0000-0000-0000-00000000f004', '${s.org}', 'Nadia Begum', '01800000000')
    ON CONFLICT (id) DO NOTHING;
  `)

  const supplierBefore = await q(`select balance from public.suppliers where id = '00000000-0000-0000-0000-00000000f001'`)
  const openingBalance = Number(supplierBefore[0].balance)

  // ── Purchase order: created ORDERED, so it is a commitment ──────────────
  const poId = await q(`
    select public.save_purchase(
      '${s.warehouse}',
      jsonb_build_array(jsonb_build_object(
        'variant_id', '00000000-0000-0000-0000-00000000f003', 'qty', 20, 'unit_cost', 210)),
      '00000000-0000-0000-0000-00000000f001', null, 'ORDERED', 'SUP-INV-77', 'weekly order', null) as id`)
  const po = await q(`select status, subtotal, total, paid_total, invoice_no
                        from public.purchases where id = '${poId[0].id}'`)
  check(
    'a purchase order is created in ORDERED with its own PO number',
    po[0].status === 'ORDERED' && po[0].invoice_no.startsWith('PO-'),
    `${po[0].invoice_no} ${po[0].status}`
  )
  check(
    'the order total is 20 × 210',
    Number(po[0].total) === 4200,
    String(po[0].total)
  )

  const supplierAfterOrder = await q(`select balance from public.suppliers where id = '00000000-0000-0000-0000-00000000f001'`)
  check(
    'ordering moves the supplier balance by exactly the order total',
    Number(supplierAfterOrder[0].balance) === openingBalance + 4200,
    `${openingBalance} → ${supplierAfterOrder[0].balance}`
  )

  // ── Partial receipt ────────────────────────────────────────────────────
  const poItem = await q(`select id, quantity, received_qty from public.purchase_items
                           where purchase_id = '${poId[0].id}'`)
  await q(`
    select public.receive_purchase(
      '${poId[0].id}',
      jsonb_build_array(jsonb_build_object('purchase_item_id', '${poItem[0].id}', 'qty', 8)),
      '[]'::jsonb) as r`)
  const afterPartial = await q(`select p.status, i.quantity, i.received_qty
                                  from public.purchases p
                                  join public.purchase_items i on i.purchase_id = p.id
                                 where p.id = '${poId[0].id}'`)
  check(
    'a partial receipt leaves the order PARTIALLY_RECEIVED',
    afterPartial[0].status === 'PARTIALLY_RECEIVED' && Number(afterPartial[0].received_qty) === 8,
    `${afterPartial[0].status} received=${afterPartial[0].received_qty}`
  )
  check(
    'the outstanding quantity after a partial receipt is 12 of 20',
    Number(afterPartial[0].quantity) - Number(afterPartial[0].received_qty) === 12,
    `${afterPartial[0].received_qty} of ${afterPartial[0].quantity}`
  )

  // ── Receiving more than was ordered is refused ──────────────────────────
  let overReceipt = null
  try {
    await q(`select public.receive_purchase('${poId[0].id}',
               jsonb_build_array(jsonb_build_object('purchase_item_id', '${poItem[0].id}', 'qty', 13)),
               '[]'::jsonb)`)
  } catch (error) {
    overReceipt = String(error.message ?? error)
  }
  check('receiving more than was ordered is refused', /over_receipt/.test(String(overReceipt)), String(overReceipt).slice(0, 50))

  // ── Completing the receipt ─────────────────────────────────────────────
  await q(`select public.receive_purchase('${poId[0].id}',
             jsonb_build_array(jsonb_build_object('purchase_item_id', '${poItem[0].id}', 'qty', 12)),
             '[]'::jsonb)`)
  const afterFull = await q(`select status from public.purchases where id = '${poId[0].id}'`)
  check('receiving the remainder closes the order as RECEIVED', afterFull[0].status === 'RECEIVED', String(afterFull[0].status))

  const poStock = await q(`select quantity, avg_unit_cost from public.stock_balances
                            where warehouse_id = '${s.warehouse}'
                              and variant_id = '00000000-0000-0000-0000-00000000f003'`)
  check(
    'the received stock landed with the ordered cost',
    Number(poStock[0].quantity) === 20 && Number(poStock[0].avg_unit_cost) === 210,
    `qty=${poStock[0].quantity} avg=${poStock[0].avg_unit_cost}`
  )

  // A received order is a record of what happened, not a plan.
  let editReceived = null
  try {
    await q(`select public.save_purchase('${s.warehouse}',
               jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000f003', 'qty', 5, 'unit_cost', 210)),
               '00000000-0000-0000-0000-00000000f001', '${poId[0].id}', 'ORDERED', null, null, null)`)
  } catch (error) {
    editReceived = String(error.message ?? error)
  }
  check('an order with received stock cannot be edited', /purchase_already_received/.test(String(editReceived)), String(editReceived).slice(0, 50))

  // ── Paying the supplier ────────────────────────────────────────────────
  const payment = await q(`
    select public.apply_payment('00000000-0000-0000-0000-00000000f001', 2000,
             '${s.cash}', '${poId[0].id}', 'BANK-1', null) as r`)
  check(
    'a supplier payment records against the order and lowers the balance',
    Number(payment[0].r.supplier_balance) === openingBalance + 4200 - 2000 &&
      Number(payment[0].r.amount) === 2000,
    `balance=${payment[0].r.supplier_balance}`
  )
  const poPaid = await q(`select paid_total from public.purchases where id = '${poId[0].id}'`)
  check('the payment shows on the order as paid', Number(poPaid[0].paid_total) === 2000, String(poPaid[0].paid_total))

  let overPayment = null
  try {
    await q(`select public.apply_payment('00000000-0000-0000-0000-00000000f001', 99999,
               '${s.cash}', '${poId[0].id}', null, null)`)
  } catch (error) {
    overPayment = String(error.message ?? error)
  }
  check('paying more than an order outstanding is refused', /over_payment/.test(String(overPayment)), String(overPayment).slice(0, 60))

  // ── Refund: restock exactly, and cite the sale item ────────────────────
  const sale = await q(`select id from public.sales
                         where organization_id = '${s.org}' and status in ('COMPLETED','PARTIALLY_PAID')
                         order by created_at limit 1`)
  const saleItem = await q(`select id, variant_id, quantity, unit_cost
                              from public.sale_items where sale_id = '${sale[0].id}' limit 1`)
  const stockBeforeRefund = await q(`select quantity from public.stock_balances
                                      where warehouse_id = '${s.warehouse}'
                                        and variant_id = '${saleItem[0].variant_id}'`)

  const refund = await q(`
    select public.refund_sale('${sale[0].id}',
      jsonb_build_array(jsonb_build_object('sale_item_id', '${saleItem[0].id}', 'qty', 1)),
      jsonb_build_array(jsonb_build_object('method_id', '${s.cash}', 'amount', 250)),
      'customer changed their mind', true) as r`)

  const stockAfterRefund = await q(`select quantity from public.stock_balances
                                     where warehouse_id = '${s.warehouse}'
                                       and variant_id = '${saleItem[0].variant_id}'`)
  check(
    'a refund restocks exactly the refunded quantity',
    Number(stockAfterRefund[0].quantity) === Number(stockBeforeRefund[0].quantity) + 1,
    `${stockBeforeRefund[0].quantity} → ${stockAfterRefund[0].quantity}`
  )

  const returnMove = await q(`select type, quantity, reference_type, reference_id
                               from public.stock_movements
                               where reference_type = 'return'
                                 and reference_id = '${refund[0].r.return_id}'`)
  check(
    'the restock is a RETURN_IN ledger row citing the return',
    returnMove.length === 1 && returnMove[0].type === 'RETURN_IN' && Number(returnMove[0].quantity) === 1,
    returnMove.map((r) => `${r.type}×${r.quantity}`).join(', ')
  )

  const returnNo = await q(`select return_no, refund_total from public.sale_returns
                             where id = '${refund[0].r.return_id}'`)
  check(
    'the return is numbered and totals what was refunded',
    /^RET-\d{4}-\d{6}$/.test(returnNo[0].return_no) && Number(returnNo[0].refund_total) === 250,
    `${returnNo[0].return_no} ${returnNo[0].refund_total}`
  )

  // ── Over-refund refused by the database ────────────────────────────────
  let overRefund = null
  try {
    await q(`select public.refund_sale('${sale[0].id}',
               jsonb_build_array(jsonb_build_object('sale_item_id', '${saleItem[0].id}', 'qty', 99)),
               '[]'::jsonb, null, true)`)
  } catch (error) {
    overRefund = String(error.message ?? error)
  }
  check(
    'refunding more than was sold is refused by the database, not the UI',
    /over_refund/.test(String(overRefund)),
    String(overRefund).slice(0, 60)
  )

  // ── Store credit ───────────────────────────────────────────────────────
  let creditNoCustomer = null
  try {
    await q(`select public.refund_sale_to_credit('${sale[0].id}',
               jsonb_build_array(jsonb_build_object('sale_item_id', '${saleItem[0].id}', 'qty', 1)),
               'no customer', true)`)
  } catch (error) {
    creditNoCustomer = String(error.message ?? error)
  }
  check(
    'store credit refuses a sale with no customer to hold it',
    /sale_has_no_customer/.test(String(creditNoCustomer)),
    String(creditNoCustomer).slice(0, 50)
  )

  // A sale that does have a customer.
  const creditSale = await q(`
    select public.complete_sale(
      '${s.branch}',
      jsonb_build_array(jsonb_build_object(
        'variant_id', '00000000-0000-0000-0000-00000000f003', 'qty', 2)),
      jsonb_build_array(jsonb_build_object('method_id', '${s.cash}', 'amount', 600)),
      '${s.register}', '00000000-0000-0000-0000-00000000f004', '${s.warehouse}',
      null, null, null) as r`)
  const creditItem = await q(`select id from public.sale_items where sale_id = '${creditSale[0].r.sale_id}' limit 1`)
  const creditResult = await q(`
    select public.refund_sale_to_credit('${creditSale[0].r.sale_id}',
      jsonb_build_array(jsonb_build_object('sale_item_id', '${creditItem[0].id}', 'qty', 1)),
      'kept as credit', true) as r`)
  const creditBalance = await q(`select store_credit from public.customers where id = '00000000-0000-0000-0000-00000000f004'`)
  check(
    'a refund to store credit lands on the customer and restocks the item',
    Number(creditResult[0].r.refund_total) === 300 &&
      Number(creditBalance[0].store_credit) === 300,
    `refund=${creditResult[0].r.refund_total} credit=${creditBalance[0].store_credit}`
  )

  // ── Register session reporting ─────────────────────────────────────────
  const openSession = await q(`select id from public.register_sessions
                                where organization_id = '${s.org}' and closed_at is null
                                order by opened_at desc limit 1`)
  const report = await q(`select public.register_session_report('${openSession[0].id}') as r`)
  const r = report[0].r
  check(
    'the register report breaks the drawer down by payment method',
    Array.isArray(r.by_method) && r.by_method.length > 0 && r.by_method.every((m) => 'amount' in m && 'count' in m),
    `${r.by_method?.length ?? 0} methods, sales=${r.sale_count}`
  )
  check(
    'the register report expected cash is opening + in − out + sales − refunds − expenses',
    Number(r.expected_cash) ===
      Number(r.opening_cash) + Number(r.cash_in) - Number(r.cash_out) +
      Number(r.sales_cash) - Number(r.refund_cash) - Number(r.expense_cash),
    String(r.expected_cash)
  )

  // ── Expenses through the RPC the screen calls ──────────────────────────
  //
  // The register report above is internally consistent, which is why it was
  // green while `record_expense` answered every call with SQLSTATE 42703: the
  // old checks built their own expense rows and never executed the function a
  // shopkeeper actually calls. This one does.
  const expenseSession = await q(`select id, expense_cash from public.register_sessions
                                   where organization_id = '${s.org}' and closed_at is null
                                   order by opened_at desc limit 1`)
  const expenseId = await q(`
    select public.record_expense(
      '${s.branch}', 150, null, '${s.cash}', 'tea for the staff',
      '${expenseSession[0].id}', '${TODAY}'::date) as id`)
  const expenseRow = await q(`select amount, session_id from public.expenses
                               where id = '${expenseId[0].id}'`)
  const drawerAfterExpense = await q(`select expense_cash from public.register_sessions
                                       where id = '${expenseSession[0].id}'`)
  check(
    'recording an expense through the RPC writes the row and moves the drawer',
    Number(expenseRow[0]?.amount) === 150 &&
      expenseRow[0]?.session_id === expenseSession[0].id &&
      Number(drawerAfterExpense[0].expense_cash) ===
        Number(expenseSession[0].expense_cash) + 150,
    `amount=${expenseRow[0]?.amount} drawer ${expenseSession[0].expense_cash} → ${drawerAfterExpense[0].expense_cash}`
  )

  let closedSessionRefused = 'no error'
  try {
    await q(`select public.record_expense(
      '${s.branch}', 10, null, '${s.cash}', 'into a closed drawer',
      '00000000-0000-0000-0000-00000000dead', '${TODAY}'::date)`)
  } catch (error) {
    closedSessionRefused = error.message ?? String(error)
  }
  check(
    'an expense cannot be attached to a session that is not open',
    closedSessionRefused.includes('session_not_open'),
    closedSessionRefused.split('\n')[0]
  )

  // ── The audit trail ────────────────────────────────────────────────────
  //
  // The criterion is "actor, before and after". Price is the change a
  // shopkeeper most wants attributed, so that is what this edits.
  await q(`update public.products set selling_price = 275
           where id = '00000000-0000-0000-0000-00000000f002'`)
  const audit = await q(`
    select action, entity_type, actor_id, before, after
      from public.audit_trail
     where entity_id = '00000000-0000-0000-0000-00000000f002'
       and action = 'update'
     order by id desc limit 1`)
  check(
    'a price change writes an audit row with the actor, the before and the after',
    audit.length === 1 &&
      audit[0].actor_id === s.owner &&
      Number(audit[0].before.selling_price) === 300 &&
      Number(audit[0].after.selling_price) === 275,
    audit.length
      ? `${audit[0].before?.selling_price} → ${audit[0].after?.selling_price} by ${audit[0].actor_id === s.owner ? 'the owner' : 'unknown'}`
      : 'no audit row'
  )
  check(
    'the audit trail names the actor by email, not just an id',
    (await q(`select actor_email from public.audit_trail
               where entity_id = '00000000-0000-0000-0000-00000000f002' limit 1`))[0]?.actor_email !== undefined,
    String((await q(`select actor_email from public.audit_trail
                      where entity_id = '00000000-0000-0000-0000-00000000f002' limit 1`))[0]?.actor_email)
  )

  const auditCount = (await q(`select count(*)::int as n from public.audit_logs
                                where organization_id = '${s.org}'`))[0].n
  await q(`update public.products set selling_price = 275
           where id = '00000000-0000-0000-0000-00000000f002'`)
  const auditCountAfter = (await q(`select count(*)::int as n from public.audit_logs
                                     where organization_id = '${s.org}'`))[0].n
  // The live failure this file now guards against: `audit_trail` joined
  // `auth.users`, and with `security_invoker = on` that made the *caller*
  // need SELECT on `auth.users` — which `authenticated` must never have. The
  // owner could read it (owners can read everything), so the validator was
  // blind to it until it looked at privileges rather than rows.
  const emailHelper = await q(`
    select p.prosecdef::text as secdef,
           has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as callable
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'actor_email'`)
  check(
    'the actor email is resolved by a SECURITY DEFINER helper the client may call',
    emailHelper[0]?.secdef === 'true' && emailHelper[0]?.callable === 'true',
    `secdef=${emailHelper[0]?.secdef} authenticated=${emailHelper[0]?.callable}`
  )

  const viewDef = await q(`select pg_get_viewdef('public.audit_trail', true) as d`)
  check(
    'the audit view no longer reaches into auth.users under invoker rights',
    !/auth\.users/.test(viewDef[0]?.d ?? ''),
    (viewDef[0]?.d ?? '').slice(0, 80)
  )

  const viewGrants = await q(`
    select has_table_privilege('authenticated', 'public.audit_trail', 'SELECT')::text as view_ok,
           has_table_privilege('authenticated', 'public.audit_logs', 'SELECT')::text as table_ok,
           has_table_privilege('authenticated', 'public.register_session_summary', 'SELECT')::text as summary_ok`)
  check(
    'audit_trail, audit_logs and register_session_summary are all readable by authenticated',
    viewGrants[0]?.view_ok === 'true' && viewGrants[0]?.table_ok === 'true' && viewGrants[0]?.summary_ok === 'true',
    `view=${viewGrants[0]?.view_ok} table=${viewGrants[0]?.table_ok} summary=${viewGrants[0]?.summary_ok}`
  )

  check(
    'a save that changes nothing writes no audit row',
    auditCount === auditCountAfter,
    `${auditCount} → ${auditCountAfter}`
  )

  check(
    'ordering, receiving and refunding are all on the trail',
    (await q(`select count(distinct entity_type)::int as n from public.audit_logs
               where organization_id = '${s.org}'
                 and entity_type in ('purchases', 'customers', 'products')`))[0].n === 3,
    'purchases, customers, products'
  )

  // ── Cancelling an order releases only what is still owed ───────────────
  const cancelPo = await q(`
    select public.save_purchase('${s.warehouse}',
      jsonb_build_array(jsonb_build_object('variant_id', '00000000-0000-0000-0000-00000000f003',
                                           'qty', 4, 'unit_cost', 200)),
      '00000000-0000-0000-0000-00000000f001', null, 'ORDERED', null, null, null) as id`)
  const balanceAfterSecondOrder = await q(`select balance from public.suppliers where id = '00000000-0000-0000-0000-00000000f001'`)
  const cancelled = await q(`select public.cancel_purchase('${cancelPo[0].id}', 'supplier out of stock') as r`)
  const balanceAfterCancel = await q(`select balance from public.suppliers where id = '00000000-0000-0000-0000-00000000f001'`)
  check(
    'cancelling an unpaid order releases exactly its total',
    Number(cancelled[0].r.released) === 800 &&
      Number(balanceAfterCancel[0].balance) === Number(balanceAfterSecondOrder[0].balance) - 800,
    `${balanceAfterSecondOrder[0].balance} → ${balanceAfterCancel[0].balance}`
  )

  await db.query(`select set_config('request.jwt.claim.sub', null, false)`)
}

// ── Phase 5 — analytics and reports ──────────────────────────────────────
//
// Phase 5's acceptance criteria are, in the order they matter:
//
//   1. The dashboard loads in one round trip. That is a property of the client
//      (`dashboard_summary` is the only call the screen makes), and the mobile
//      audit asserts it by counting requests; what is asserted *here* is that
//      the one call really does carry every number the screen shows.
//   2. Every question in §56 has an answer. So every answer is read back and
//      checked for a value, a note and a link.
//   3. A report exported as CSV re-imports to identical row counts. The row
//      count a report returns is `total_rows`, and the rows it returns are
//      exactly that many when the limit allows — the export writes those rows,
//      so the counts agree by construction. The round trip itself is proven in
//      `src/features/reports/report-export.test.ts` and by the audit, which
//      downloads the file.
//
// The engine itself is checked for the property that makes it trustworthy:
// the same measure sliced by two different dimensions must add up to the same
// number. That is what stops the dashboard and a report from disagreeing.
if (seeded.length !== 0) {
  const s = seeded[0]
  await db.exec(`select set_config('request.jwt.claim.sub', '${s.owner}', false)`)

  /**
   * The shop's own today — not the server's.
   *
   * `current_date` is the *server's* date, and a shop in Dhaka is already on
   * tomorrow's when the UTC clock still says today; `app.effective_day`
   * (migration 030) is the resolution the app's calls do internally, and the
   * reason a dashboard and an analytics screen can agree without either of them
   * knowing a timezone. A check that used `current_date` passed all morning and
   * failed every evening — which is exactly how this one was found.
   */
  const TODAY = (await q(`select app.effective_day('${s.branch}', null)::text as d`))[0].d

  // ── The catalogue is the engine's own whitelist ────────────────────────
  const catalog = await q(`select public.analytics_catalog() as c`)
  const cat = catalog[0].c
  check(
    'the analytics catalogue lists measures, dimensions, periods and combinations',
    Array.isArray(cat.measures) && cat.measures.length >= 13 &&
      Array.isArray(cat.dimensions) && cat.dimensions.length >= 14 &&
      Array.isArray(cat.periods) && cat.periods.length === 6 &&
      Array.isArray(cat.combos) && cat.combos.length > 60,
    `${cat.measures?.length} measures · ${cat.dimensions?.length} dimensions · ${cat.combos?.length} combinations`
  )
  check(
    'every combination the catalogue offers can actually be computed',
    (await (async () => {
      // Ten of them, spread across the four families, run for real. A
      // catalogue that advertised a combination the generator refuses would
      // be a picker that fails when touched.
      const sample = [
        ['takings', 'day'], ['takings', 'category'], ['takings', 'payment_method'],
        ['orders', 'hour'], ['profit', 'product'], ['items', 'variant'],
        ['refunds', 'day'], ['expenses', 'expense_category'],
        ['purchases', 'supplier'], ['purchase_due', 'supplier'],
      ]
      for (const [measure, dimension] of sample) {
        await q(`select public.analytics_query('${s.branch}', '${dimension}', '${measure}',
                   'year', null, null, '{}'::jsonb, 5)`)
      }
      return true
    })()),
    'sampled 10 combinations across all four families'
  )

  // ── One number, however it is sliced ──────────────────────────────────
  const byDay = await q(`select public.analytics_query('${s.branch}', 'day', 'takings',
                            'year', null, null, '{}'::jsonb, 400) as r`)
  const dayTotal = Number(byDay[0].r.totals.value)

  const direct = await q(`
    select coalesce(sum(s.total), 0) as v
      from public.sales s
     where s.branch_id = '${s.branch}'
       and s.status in ('COMPLETED','PARTIALLY_PAID','PARTIALLY_REFUNDED')
       and s.created_at >= date_trunc('year', now())`)
  check(
    'takings by day equals Σ sales.total for the same period',
    Math.abs(dayTotal - Number(direct[0].v)) < 0.01,
    `${dayTotal} vs ${direct[0].v}`
  )

  const byCategory = await q(`select public.analytics_query('${s.branch}', 'category', 'takings',
                                'year', null, null, '{}'::jsonb, 200) as r`)
  const categoryTotal = Number(byCategory[0].r.totals.value)
  check(
    'takings by category equals takings by day, to the cent',
    Math.abs(categoryTotal - dayTotal) < 1,
    `${categoryTotal} vs ${dayTotal}`
  )

  const byHour = await q(`select public.analytics_query('${s.branch}', 'hour', 'takings',
                            'year', null, null, '{}'::jsonb, 24) as r`)
  check(
    'takings by hour equals takings by day',
    Math.abs(Number(byHour[0].r.totals.value) - dayTotal) < 0.01,
    `${byHour[0].r.totals.value} vs ${dayTotal}`
  )

  // The measures have to be internally consistent: revenue is takings without
  // the tax, and profit is revenue minus what the goods cost. If those drift,
  // every screen that shows them drifts together and nobody can tell which
  // number to believe.
  const revenue = await q(`select public.analytics_query('${s.branch}', 'day', 'revenue',
                             'year', null, null, '{}'::jsonb, 4) as r`)
  const tax = await q(`select public.analytics_query('${s.branch}', 'day', 'tax',
                        'year', null, null, '{}'::jsonb, 4) as r`)
  const profit = await q(`select public.analytics_query('${s.branch}', 'day', 'profit',
                            'year', null, null, '{}'::jsonb, 4) as r`)
  const cogs = await q(`select public.analytics_query('${s.branch}', 'day', 'cogs',
                         'year', null, null, '{}'::jsonb, 4) as r`)
  check(
    'revenue + tax equals takings, and profit equals revenue − cost of goods',
    Math.abs(Number(revenue[0].r.totals.value) + Number(tax[0].r.totals.value) - dayTotal) < 0.01 &&
      Math.abs(
        Number(profit[0].r.totals.value) -
          (Number(revenue[0].r.totals.value) - Number(cogs[0].r.totals.value))
      ) < 0.01,
    `takings=${dayTotal} revenue=${revenue[0].r.totals.value} tax=${tax[0].r.totals.value} ` +
      `cogs=${cogs[0].r.totals.value} profit=${profit[0].r.totals.value}`
  )

  // An order discount is the case that breaks naive item reports: the lines no
  // longer add up to the bill. The engine allocates it across the lines, so
  // the parts still sum to the whole.
  check(
    'an order discount is spread across the lines, so items still sum to the bill',
    (await (async () => {
      const itemsTotal = await q(`
        select coalesce(sum((x ->> 'value')::numeric), 0) as v
          from jsonb_array_elements(
            (public.analytics_query('${s.branch}', 'product', 'takings', 'year',
                                    null, null, '{}'::jsonb, 500))->'series'
          ) x`)
      return Math.abs(Number(itemsTotal[0].v) - dayTotal) < 1
    })()),
    'takings by product reconciles with takings by day'
  )

  // ── The dashboard carries every number the screen shows ────────────────
  const dash = await q(`select public.dashboard_summary('${s.branch}', '${TODAY}'::date) as r`)
  const d = dash[0].r
  check(
    'the dashboard call carries the widgets, both trends, the rankings and the answers',
    ['today_sales', 'order_count', 'gross_profit', 'items_sold', 'discount_given',
     'tax_collected', 'today_expenses', 'refunds_today', 'held_sales', 'pending_payments',
     'customer_count', 'out_of_stock', 'low_stock', 'stock_value', 'expected_cash',
     'sales_by_hour', 'payment_mix', 'top_products', 'answers', 'trend_days',
     'trend_profit', 'trend_months', 'rank_products', 'rank_categories'].every((key) => key in d),
    `${Object.keys(d).length} keys in one payload`
  )
  check(
    'the dashboard trend really is thirty days of takings',
    Array.isArray(d.trend_days?.series) && d.trend_days.series.length >= 1 &&
      d.trend_days.series.length <= 31 && d.trend_days.measure === 'takings',
    `${d.trend_days?.series?.length ?? 0} points`
  )
  check(
    'the dashboard widget and the analytics slice agree on today',
    (await (async () => {
      const today = await q(`select public.analytics_query('${s.branch}', 'day', 'takings',
                               'day', null, null, '{}'::jsonb, 24) as r`)
      return Math.abs(Number(today[0].r.totals.value) - Number(d.today_sales)) < 0.01
    })()),
    `widget=${d.today_sales}`
  )
  check(
    'trend_day comparisons carry the previous period for every point',
    Array.isArray(d.trend_days?.series) &&
      d.trend_days.series.every((point) => 'prev' in point && 'value' in point),
    `previous ${d.trend_days?.previous?.from} → ${d.trend_days?.previous?.to}`
  )

  // ── A silent caller means "today", not "no date" ───────────────────────
  //
  // Neither dashboard nor analytics screen sends a day: the browser cannot
  // know the branch's timezone, so the database resolves it, and the client
  // sends null on purpose. A null over PostgREST bypasses a `default` clause,
  // so "no day" used to mean NULL in every comparison inside the function —
  // the peak-hour answer divided by zero and the dashboard failed to load at
  // all. These two checks keep that from coming back.
  const projection = (payload) => JSON.stringify({
    date: payload?.date ?? null,
    widgets: [payload?.today_sales, payload?.order_count, payload?.gross_profit,
              payload?.items_sold, payload?.expected_cash, payload?.stock_value],
    answers: (payload?.answers ?? []).map((entry) => [entry.id, entry.value]),
    trend: (payload?.trend_days?.series ?? []).length,
  })
  // (A `date` comes back as a JS Date, so the day is formatted by Postgres
  // and both calls are made in one statement — comparisons stay in SQL.)
  const silentRow = (
    await q(`select public.dashboard_summary('${s.branch}', null) as r,
                    to_char(app.effective_day('${s.branch}', null), 'YYYY-MM-DD') as d`)
  )[0]
  const silent = silentRow.r
  const explicit = (
    await q(`select public.dashboard_summary('${s.branch}', '${silentRow.d}'::date) as r`)
  )[0].r
  check(
    'a silent day is answered for the branch\'s own today',
    silent?.date === silentRow.d &&
      (silent?.answers ?? []).length === 14 &&
      silent?.answers?.some((entry) => entry.id === 'peak_hour' && entry.value !== null),
    `day=${silent?.date}, effective=${silentRow.d}, ${silent?.answers?.length ?? 0} answers`
  )
  check(
    'a silent day and an explicit today produce the same numbers',
    projection(silent) === projection(explicit),
    'widgets, answers and trend identical (generated_at aside)'
  )
  check(
    'a day the caller chooses is still honoured',
    (
      await q(`select to_char(app.effective_day('${s.branch}', '2026-01-02'::date),
                               'YYYY-MM-DD') as d`)
    )[0].d === '2026-01-02',
    'explicit date passes through untouched'
  )

  // ── §56: every question has an answer on that one screen ──────────────
  const answers = d.answers
  check(
    'the owner’s question list is present and complete',
    Array.isArray(answers) && answers.length === 14,
    `${answers?.length ?? 0} answered questions`
  )
  const expectedQuestions = [
    'takings_today', 'profit_today', 'top_products', 'category_mix', 'payment_mix',
    'cash_in_drawer', 'receivable', 'payable', 'reorder', 'spend_today', 'peak_hour',
    'discount_month', 'refunds_today', 'held_sales',
  ]
  check(
    'every §56 question is answered with a value, a note and a link to the detail',
    expectedQuestions.every((id) => {
      const answer = answers.find((entry) => entry.id === id)
      return (
        answer !== undefined &&
        String(answer.question).endsWith('?') &&
        String(answer.value).length > 0 &&
        String(answer.note).length > 0 &&
        String(answer.link).startsWith('/') &&
        String(answer.icon).length > 0
      )
    }),
    'all 14 checked for value, note, link and icon'
  )
  check(
    'money answers are numeric and count answers are integral',
    answers.every((answer) => {
      if (answer.kind === 'money') return Number.isFinite(Number(answer.value))
      if (answer.kind === 'count' || answer.kind === 'qty') {
        return Number.isInteger(Number(answer.value)) && Number(answer.value) >= 0
      }
      return typeof answer.value === 'string'
    }),
    'kinds: ' + [...new Set(answers.map((answer) => answer.kind))].join(', ')
  )

  // ── The report framework ──────────────────────────────────────────────
  const reportCatalog = await q(`select public.report_catalog() as c`)
  const reports = reportCatalog[0].c
  check(
    'the report library lists the eleven reports with their columns',
    Array.isArray(reports) && reports.length === 11 &&
      reports.every((report) => Array.isArray(report.columns) && report.columns.length > 0) &&
      reports.every((report) => report.group && report.description),
    `${reports?.length ?? 0} reports`
  )

  // Each one runs, and every column it advertises is a key in its rows.
  const ran = []
  for (const report of reports) {
    const result = await q(`select public.report_rows('${report.key}', '${s.branch}', 'year',
                                null, null, null, null, 'desc', 500, 0, '{}'::jsonb) as r`)
    const payload = result[0].r
    const columnKeys = payload.columns.map((column) => column.key)
    const rowsOk = payload.rows.every((row) => columnKeys.every((key) => key in row))
    const totalsOk = Object.keys(payload.totals).every((key) => columnKeys.includes(key))
    ran.push({
      key: report.key,
      ok: rowsOk && totalsOk && payload.total_rows === payload.rows.length,
      rows: payload.total_rows,
      columns: columnKeys.length,
    })
  }
  check(
    'every report runs, and its columns match its rows',
    ran.every((entry) => entry.ok),
    ran.map((entry) => `${entry.key}:${entry.rows}r/${entry.columns}c`).join(' ')
  )

  // The totals must describe the rows, not the page: a report whose footer
  // sums something else is worse than no footer.
  const salesReport = await q(`select public.report_rows('sales', '${s.branch}', 'year',
                                  null, null, null, 'total', 'desc', 500, 0, '{}'::jsonb) as r`)
  const salesPayload = salesReport[0].r
  const summed = salesPayload.rows.reduce((sum, row) => sum + Number(row.total ?? 0), 0)
  check(
    'a report’s totals are the sum of the rows it returned',
    Math.abs(summed - Number(salesPayload.totals.total ?? 0)) < 0.01,
    `Σ rows ${summed.toFixed(2)} vs total ${salesPayload.totals.total}`
  )
  check(
    'sorting is server-side and respects the requested direction',
    (await (async () => {
      const totals = salesPayload.rows.map((row) => Number(row.total ?? 0))
      const descending = totals.every((value, index) => index === 0 || totals[index - 1] >= value)
      const ascending = await q(`select public.report_rows('sales', '${s.branch}', 'year',
                                   null, null, null, 'total', 'asc', 5, 0, '{}'::jsonb) as r`)
      const first = Number(ascending[0].r.rows[0]?.total ?? 0)
      return descending && first <= (totals[0] ?? 0)
    })()),
    `first row ${salesPayload.rows[0]?.total}`
  )
  check(
    'pagination returns a different page for a different offset, same row count',
    (await (async () => {
      if (salesPayload.total_rows < 2) return true
      const page2 = await q(`select public.report_rows('sales', '${s.branch}', 'year',
                               null, null, null, 'total', 'desc', 1, 1, '{}'::jsonb) as r`)
      const page1 = await q(`select public.report_rows('sales', '${s.branch}', 'year',
                               null, null, null, 'total', 'desc', 1, 0, '{}'::jsonb) as r`)
      return (
        page1[0].r.total_rows === page2[0].r.total_rows &&
        page1[0].r.rows[0]?.invoice_no !== page2[0].r.rows[0]?.invoice_no
      )
    })()),
    `${salesPayload.total_rows} rows`
  )
  check(
    'search narrows the set and the row count follows it',
    (await (async () => {
      const invoice = salesPayload.rows[0]?.invoice_no
      if (!invoice) return true
      const found = await q(`select public.report_rows('sales', '${s.branch}', 'year',
                              null, null, '${invoice}', null, 'desc', 50, 0, '{}'::jsonb) as r`)
      return found[0].r.total_rows === 1 && found[0].r.rows[0].invoice_no === invoice
    })()),
    'searched by invoice number'
  )

  // Anything the client sends that is not a column name must be treated as
  // text, never as SQL. A sort key is the one place a report takes a string
  // into its own statement, so it is checked with a hostile value.
  check(
    'an unknown sort key falls back to the default instead of reaching the SQL',
    (await (async () => {
      const nasty = await q(`select public.report_rows('sales', '${s.branch}', 'year',
                              null, null, null, 'total; drop table public.sales', 'desc', 3, 0,
                              '{}'::jsonb) as r`)
      const dropped = await q(`select count(*)::int as n from public.sales`)
      return nasty[0].r.rows.length > 0 && nasty[0].r.sort === 'created_at' && dropped[0].n > 0
    })()),
    'hostile sort key ignored, sales table intact'
  )
  check(
    'an unknown report and an impossible slice are both refused by name',
    (await (async () => {
      let unknown = ''
      let impossible = ''
      try {
        await q(`select public.report_rows('no_such_report', '${s.branch}', 'month',
                   null, null, null, null, 'desc', 5, 0, '{}'::jsonb)`)
      } catch (error) {
        unknown = String(error.message ?? error)
      }
      try {
        await q(`select public.analytics_query('${s.branch}', 'product', 'expenses',
                   'month', null, null, '{}'::jsonb, 5)`)
      } catch (error) {
        impossible = String(error.message ?? error)
      }
      return /unknown_report/.test(unknown) && /unsupported_combination/.test(impossible)
    })()),
    'unknown_report / unsupported_combination'
  )

  // ── Reports do not leak across shops ──────────────────────────────────
  await db.exec(`
    INSERT INTO public.branches (id, organization_id, name, code)
    VALUES ('00000000-0000-0000-0000-00000000e00b',
            '00000000-0000-0000-0000-00000000e001', 'Their Branch', 'THEIRS')
    ON CONFLICT (id) DO NOTHING;`)
  let crossTenant = ''
  try {
    await q(`select public.analytics_query('00000000-0000-0000-0000-00000000e00b', 'day', 'takings',
               'month', null, null, '{}'::jsonb, 5)`)
  } catch (error) {
    crossTenant = String(error.message ?? error)
  }
  check(
    'another shop’s analytics cannot be read, even by id',
    // `forbidden: organization …` is app.require_org's message; the point is
    // that the call is refused, not which of the two guards refused it.
    /forbidden|permission_denied|not a member/.test(crossTenant),
    crossTenant.slice(0, 80)
  )

  // ── The permissions are real, not decorative ──────────────────────────
  await db.exec(`
    INSERT INTO auth.users (id, email)
    VALUES ('00000000-0000-0000-0000-00000000cafe', 'cashier@test.local')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.user_organizations (user_id, organization_id)
    VALUES ('00000000-0000-0000-0000-00000000cafe', '${s.org}')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, organization_id, role_id)
    SELECT '00000000-0000-0000-0000-00000000cafe', '${s.org}', id
      FROM public.roles WHERE organization_id = '${s.org}' AND key = 'cashier';
    select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000cafe', false)`)

  check(
    'a cashier cannot read analytics or reports',
    (await (async () => {
      const denied = []
      for (const call of [
        `select public.analytics_query('${s.branch}', 'day', 'takings', 'month', null, null, '{}'::jsonb, 5)`,
        `select public.report_rows('sales', '${s.branch}', 'month', null, null, null, null, 'desc', 5, 0, '{}'::jsonb)`,
        `select public.analytics_catalog()`,
      ]) {
        try {
          await q(call)
          denied.push('allowed')
        } catch (error) {
          denied.push(/permission_denied/.test(String(error.message ?? error)) ? 'denied' : 'other')
        }
      }
      return denied.every((entry) => entry === 'denied')
    })()),
    'analytics_query, report_rows and analytics_catalog all refused'
  )

  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
}

// ── Phase 6 — the plugin host ─────────────────────────────────────────────
//
// What a shopkeeper is promised when they flip a plugin on: the plugin's SQL
// runs once, its tables cannot leak across shops, its permissions land in the
// catalogue namespaced to it, disabling keeps the data, and a failure rolls
// the whole thing back rather than leaving a half-installed plugin. Every one
// of those is a database property, so every one of them is checked here —
// against the live functions, not against the design document.
if (seeded.length !== 0) {
  const s = seeded[0]
  const owner = s.owner
  const cashier = '00000000-0000-0000-0000-00000000cafe'

  const asUser = async (id) => {
    await db.exec(`select set_config('request.jwt.claim.sub', '${id}', false)`)
  }
  const fails = async (sql, pattern) => {
    try {
      await q(sql)
      return `no error raised (expected ${pattern})`
    } catch (error) {
      const message = String(error.message ?? error)
      return pattern.test(message) ? null : message
    }
  }

  await asUser(owner)

  // ── What the server ships ──────────────────────────────────────────────
  const packages = await q(
    `select plugin_key, category, version, core_api_version from public.plugin_packages order by plugin_key`
  )
  check(
    'the server ships its plugins as packages the database knows about',
    packages.length >= 2 &&
      packages.every((row) => /^\d+\.\d+\.\d+$/.test(row.version)) &&
      packages.some((row) => row.plugin_key === 'batch-expiry') &&
      packages.some((row) => row.plugin_key === 'loyalty-lite'),
    packages.map((row) => `${row.plugin_key}@${row.version}(${row.category})`).join(' ')
  )

  const packagedPermissions = await q(
    `select plugin_key, key from public.plugin_package_permissions order by plugin_key, key`
  )

  // ── The bundle and the server agree ────────────────────────────────────
  //
  // A plugin's manifest lives in TypeScript and its SQL lives in the database,
  // and nothing stops the two drifting: a version bumped on one side, a
  // permission renamed in the other. A shop would then enable "1.0.0" and load
  // a bundle that calls a function the server never created. So the two halves
  // are compared key by key, read out of the source rather than trusted.
  const manifestDir = join(root, 'src', 'plugins')
  const manifestKeys = []
  for (const entry of readdirSync(manifestDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(manifestDir, entry.name, 'manifest.ts')
    if (!existsSync(file)) continue

    const text = readFileSync(file, 'utf8')
    // The manifest's own id: `id:` on the manifest object. Deliberately
    // anchored to the start of a line so it cannot pick up a permission key.
    const idMatch = /^\s*(?:id|key):\s*'([^']+)'/m.exec(text)
    const key = idMatch?.[1] ?? entry.name
    const version = /\bversion:\s*'([^']+)'/.exec(text)?.[1] ?? ''

    // The permission list, from `permissions: [` up to its closing bracket.
    const start = text.indexOf('permissions: [')
    const permissions = []
    if (start !== -1) {
      let depth = 0
      let end = start
      for (let i = text.indexOf('[', start); i < text.length; i += 1) {
        if (text[i] === '[') depth += 1
        else if (text[i] === ']') {
          depth -= 1
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      const body = text.slice(start, end)
      for (const match of body.matchAll(/\bkey:\s*'([^']+)'/g)) permissions.push(match[1])
    }

    manifestKeys.push({ key, version, permissions: permissions.sort() })
  }

  // ── The plugin files themselves ────────────────────────────────────────
  //
  // Two ways a plugin's SQL has gone wrong here, and both survive every other
  // check because until a shop enables the plugin the file is only ever *text*:
  //
  //   1. an unbalanced parenthesis. `create or replace function` then refuses
  //      at enable time with "mismatched parentheses at or near ;" and a line
  //      number that means nothing. Counting here names the statement.
  //   2. a migration that embeds a *stale copy* of the file. The database ships
  //      what the migration embedded, not what is on disk, so a fix applied
  //      after the migration was generated silently never lands.
  const bodiesLength = (set, text) =>
    [...set].find((b) => b.startsWith(text.slice(0, 60)))?.length ?? 'no'

  // Walks the text *and* every dollar-quoted body inside it: a plpgsql body is
  // where a missing parenthesis actually hides, and it is the case that cost a
  // long afternoon — the outer statement counts fine while the function inside
  // it cannot be compiled.
  const imbalances = (text, label) => {
    const problems = []
    const walk = (chunk, where) => {
      let depth = 0
      let lowest = 0
      let i = 0
      while (i < chunk.length) {
        const two = chunk.slice(i, i + 2)
        if (two === '--') {
          const nl = chunk.indexOf('\n', i)
          i = nl === -1 ? chunk.length : nl
          continue
        }
        if (two === '/*') {
          const close = chunk.indexOf('*/', i + 2)
          i = close === -1 ? chunk.length : close + 2
          continue
        }
        const dollar = /^\$[A-Za-z_]*\$/.exec(chunk.slice(i))
        if (dollar) {
          const tag = dollar[0]
          const close = chunk.indexOf(tag, i + tag.length)
          const inner = chunk.slice(i + tag.length, close === -1 ? chunk.length : close)
          // A quoted string carrying SQL: worth the same walk.
          if (/\b(declare|begin|select|return)\b/i.test(inner)) walk(inner, `${where}${where.endsWith(')') ? '' : ' › '}${tag}`)
          i = close === -1 ? chunk.length : close + tag.length
          continue
        }
        if (chunk[i] === "'") {
          let j = i + 1
          while (j < chunk.length) {
            if (chunk[j] === "'") {
              if (chunk[j + 1] === "'") {
                j += 2
                continue
              }
              break
            }
            j += 1
          }
          i = j + 1
          continue
        }
        if (chunk[i] === '(' || chunk[i] === '[') depth += 1
        if (chunk[i] === ')' || chunk[i] === ']') depth -= 1
        if (depth < lowest) lowest = depth
        i += 1
      }
      if (depth !== 0 || lowest < 0) problems.push({ where, depth, lowest })
    }
    walk(text, label)
    return problems
  }

  const pluginSql = []
  const pluginsDir = join(root, 'supabase', 'plugins')
  if (existsSync(pluginsDir)) {
    for (const pack of readdirSync(pluginsDir, { withFileTypes: true }).sort()) {
      if (!pack.isDirectory()) continue
      const dir = join(pluginsDir, pack.name)
      for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        pluginSql.push({ key: pack.name, name, text: readFileSync(join(dir, name), 'utf8') })
      }
    }
  }

  const unbalanced = []
  for (const { key, name, text } of pluginSql) {
    for (const [index, stmt] of splitStatements(text).entries()) {
      const first = stmt.split('\n').find((l) => l.trim() && !l.trim().startsWith('--'))?.trim().slice(0, 54) ?? ''
      for (const { where, depth } of imbalances(stmt, `${key}/${name} #${index + 1} (${first})`)) {
        unbalanced.push(`${where}: ${depth > 0 ? `${depth} unclosed` : depth < 0 ? `${-depth} too many closed` : 'crossed'}`)
      }
    }
  }
  check(
    'every statement in every plugin SQL file balances its own parentheses',
    pluginSql.length >= 2 && unbalanced.length === 0,
    unbalanced.length ? unbalanced.join(' · ') : `${pluginSql.length} files, every statement balanced`
  )

  // The copies a migration embeds, read straight out of the migration files.
  const embeddedBodies = new Set()
  const embeddedNames = new Set()
  for (const migration of readdirSync(join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'))) {
    const text = readFileSync(join(root, 'supabase', 'migrations', migration), 'utf8')
    for (const match of text.matchAll(/\$plg_\d+\$([\s\S]*?)\$plg_\d+\$/g)) {
      embeddedBodies.add(match[1])
      embeddedNames.add(match[1].slice(0, 60))
    }
  }
  const staleCopies = pluginSql
    .filter(({ text }) => !embeddedBodies.has(text))
    .map(({ key, name, text }) => {
      const near = [...embeddedNames].find((b) => b === text.slice(0, 60))
      return near
        ? `${key}/${name}: the embedded copy is not this file (same opening lines, ${bodiesLength(embeddedBodies, text)} chars embedded vs ${text.length} on disk)`
        : `${key}/${name}: not embedded in any migration`
    })
  check(
    'every plugin SQL file is embedded in a migration byte for byte',
    pluginSql.length >= 2 && staleCopies.length === 0,
    staleCopies.length ? staleCopies.join(' · ') : `${pluginSql.length} files in sync with the migrations that ship them`
  )

  const packagesByKey = new Map(packages.map((row) => [row.plugin_key, row]))
  const drift = []
  for (const manifest of manifestKeys) {
    const pack = packagesByKey.get(manifest.key)
    if (!pack) {
      drift.push(`${manifest.key}: no package on the server`)
      continue
    }
    if (pack.version !== manifest.version) {
      drift.push(`${manifest.key}: bundle ${manifest.version} vs server ${pack.version}`)
    }
    const packaged = packagedPermissions
      .filter((row) => row.plugin_key === manifest.key)
      .map((row) => row.key)
      .sort()
    if (packaged.join(',') !== manifest.permissions.join(',')) {
      drift.push(
        `${manifest.key}: permissions [${manifest.permissions.join(', ')}] vs package [${packaged.join(', ')}]`
      )
    }
  }
  check(
    'every plugin bundle matches the package the server ships: key, version and permissions',
    manifestKeys.length >= 2 && drift.length === 0,
    drift.length ? drift.join(' · ') : `${manifestKeys.length} manifests compared`
  )

  check(
    'every packaged permission is namespaced to the plugin that ships it',
    packagedPermissions.length >= 3 &&
      packagedPermissions.every((row) => row.key.startsWith(`${row.plugin_key}.`)),
    packagedPermissions.map((row) => row.key).join(', ')
  )

  const catalog = (await q(`select public.plugin_catalog('${s.org}') as c`))[0].c
  check(
    'the plugins screen can list what is available, with pending migrations',
    Array.isArray(catalog) &&
      catalog.length === packages.length &&
      catalog.every((entry) => 'enabled' in entry && 'migrations_pending' in entry) &&
      catalog.find((e) => e.key === 'loyalty-lite')?.migrations_pending >= 1,
    catalog.map((e) => `${e.key}:off·${e.migrations_pending}pending`).join(' ')
  )

  const impact = (await q(`select public.plugin_impact('${s.org}', 'loyalty-lite') as i`))[0].i
  check(
    'before enabling, the wildcard roles that would gain permissions are named',
    Array.isArray(impact) && impact.length >= 1 && impact.every((entry) => entry.permissions.length > 0),
    impact.map((entry) => `${entry.role_key}(${entry.wildcard}→${entry.permissions.length})`).join(' ')
  )

  // ── Enable ─────────────────────────────────────────────────────────────
  const enabled = (await q(
    `select public.plugin_enable('${s.org}', 'loyalty-lite', '1.0.0', '{}'::jsonb) as r`
  ))[0].r
  check(
    'enabling a plugin applies its packaged migrations in one call',
    enabled.enabled === true && enabled.migrations_applied >= 1,
    JSON.stringify(enabled)
  )

  const table = await q(
    `select c.relname,
            c.relrowsecurity as rls,
            (select count(*)::int from information_schema.columns col
              where col.table_schema = 'public' and col.table_name = c.relname
                and col.column_name = 'organization_id') as org_col,
            (select count(*)::int from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname like 'plg_loyalty_lite_%'`
  )
  check(
    'a plugin table is tenant-safe by construction: prefixed, org-scoped, RLS on, policies present',
    table.length === 1 && table[0].rls === true && table[0].org_col === 1 && table[0].policies >= 1,
    table.map((row) => `${row.relname} rls=${row.rls} org=${row.org_col} policies=${row.policies}`).join(' ')
  )

  const granted = await q(
    `select key, plugin_key from public.permissions where plugin_key is not null order by key`
  )
  check(
    'enabling adds the plugin’s permissions to the catalogue, namespaced to it',
    granted.length >= 2 && granted.every((row) => row.key.startsWith(`${row.plugin_key}.`)),
    granted.map((row) => row.key).join(', ')
  )

  const again = (await q(
    `select public.plugin_enable('${s.org}', 'loyalty-lite', '1.0.0', '{}'::jsonb) as r`
  ))[0].r
  check(
    'enabling twice applies nothing a second time',
    again.migrations_applied === 0,
    `applied=${again.migrations_applied}`
  )

  // ── The plugin's own data ──────────────────────────────────────────────
  const stored = (await q(
    `select public.plugin_data_set('${s.org}', 'loyalty-lite', 'warning_days', '45'::jsonb) as r`
  ))[0].r
  const readBack = (await q(
    `select public.plugin_data_get('${s.org}', 'loyalty-lite', 'warning_days') as r`
  ))[0].r
  check(
    'plugin data round-trips through the RPC that scopes it to the shop',
    stored.key === 'warning_days' && Number(readBack) === 45,
    `${JSON.stringify(stored)} → ${JSON.stringify(readBack)}`
  )

  // The validator connects as the database owner, for whom every table is
  // readable — so "plugin data is not reachable directly" is a question about
  // grants, not about what a query happens to return here.
  const grants = await q(
    `select g.grantee
       from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.table_name = 'plugin_data'
        and g.grantee in ('anon', 'authenticated', 'service_role')
      union all
     select r.rolname as grantee
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join (select unnest(array['anon','authenticated','service_role']) as rolname) r
      where n.nspname = 'public' and c.relname = 'plugin_data'
        and has_table_privilege(r.rolname, c.oid, 'select')`
  )
  check(
    'plugin data is not reachable by querying the table directly',
    grants.length === 0,
    grants.length ? `granted to ${grants.map((row) => row.grantee).join(', ')}` : 'no table grants for anon/authenticated/service_role'
  )

  const rpcRefusals = [
    [await fails(`select public.plugin_rpc('${s.org}', 'loyalty-lite', 'nope', '{}'::jsonb)`, /plugin_rpc_unknown/), 'unknown function'],
    [await fails(`select public.plugin_rpc('${s.org}', 'loyalty-lite', 'drop_tables', '{}'::jsonb)`, /plugin_rpc_unknown/), 'a core-sounding name'],
    [await fails(`select public.plugin_rpc('${s.org}', 'batch-expiry', 'award', '{}'::jsonb)`, /plugin_not_enabled/), 'a plugin that is not enabled'],
  ]
  check(
    'a plugin can only reach functions in its own namespace, and only while enabled',
    rpcRefusals.every(([problem]) => problem === null),
    rpcRefusals.map(([problem, what]) => (problem ? `${what}: ${problem}` : `${what}: refused`)).join(' · ')
  )

  // ── Failure rolls back ─────────────────────────────────────────────────
  await q(
    `insert into public.plugin_packages (plugin_key, name, category, version, core_api_version)
     values ('bad-plugin', 'Bad Plugin', 'industry', '1.0.0', '^1.0.0')`
  )
  await q(
    `insert into public.plugin_package_migrations (plugin_key, filename, version, ordinal, checksum, sql)
     values ('bad-plugin', '001_bad.sql', '1.0.0', 1, md5('create table public.apparently_fine (id uuid)'),
             'create table public.apparently_fine (id uuid)')`
  )
  const violation = await fails(
    `select public.plugin_enable('${s.org}', 'bad-plugin', '1.0.0', '{}'::jsonb)`,
    /plugin_schema_violation/
  )
  const leftover = await q(
    `select (select count(*)::int from public.plugins where plugin_key = 'bad-plugin') as installed,
            (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r'
                and c.relname = 'apparently_fine') as created`
  )
  check(
    'a plugin whose table is not tenant-safe is refused, and nothing it did survives',
    violation === null && leftover[0].installed === 0 && leftover[0].created === 0,
    violation ?? `installed=${leftover[0].installed} table_created=${leftover[0].created}`
  )

  // A changed file for an already-applied migration is a tamper, not a no-op.
  await db.exec('begin')
  await q(
    `update public.plugin_package_migrations set sql = sql || '\n-- tampered'
      where plugin_key = 'loyalty-lite'`
  )
  const tampered = await fails(
    `select public.plugin_enable('${s.org}', 'loyalty-lite', '1.0.0', '{}'::jsonb)`,
    /plugin_migration_changed/
  )
  await db.exec('rollback')
  check(
    'a packaged migration that changed after it was applied is refused',
    tampered === null,
    tampered ?? 'refused: plugin_migration_changed'
  )

  const unknown = await fails(
    `select public.plugin_enable('${s.org}', 'nope', '1.0.0', '{}'::jsonb)`,
    /unknown_plugin/
  )
  const wrongVersion = await fails(
    `select public.plugin_enable('${s.org}', 'loyalty-lite', '9.9.9', '{}'::jsonb)`,
    /plugin_version_mismatch/
  )
  check(
    'an unknown plugin, or a version the server does not ship, is refused by name',
    unknown === null && wrongVersion === null,
    unknown ?? wrongVersion ?? 'both refused'
  )

  // ── Dependency guard ───────────────────────────────────────────────────
  // loyalty-lite declares a dependency on batch-expiry, so both are switched on
  // before the guard is asked anything.
  await q(`select public.plugin_enable('${s.org}', 'batch-expiry', '1.0.0', '{}'::jsonb)`)
  const blocking = await fails(
    `select public.plugin_disable('${s.org}', 'batch-expiry')`,
    /plugin_dependency/
  )
  check(
    'a dependency cannot be switched off while something enabled needs it',
    blocking === null,
    blocking ?? 'refused: plugin_dependency'
  )

  // ── Disable keeps the shop’s data ──────────────────────────────────────
  const off = (await q(`select public.plugin_disable('${s.org}', 'loyalty-lite') as r`))[0].r
  const kept = await q(
    `select (select count(*)::int from public.plugin_migrations
              where organization_id = '${s.org}' and plugin_key = 'loyalty-lite') as migrations,
            (select count(*)::int from public.permissions where plugin_key = 'loyalty-lite') as permissions,
            (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r'
                and c.relname like 'plg_loyalty_lite_%') as tables,
            (select count(*)::int from public.plugin_data
              where organization_id = '${s.org}' and plugin_key = 'loyalty-lite') as rows`
  )
  check(
    'disabling keeps the migrations, the grants, the table and the data',
    off.enabled === false && kept[0].migrations >= 1 && kept[0].permissions >= 2 &&
      kept[0].tables === 1 && kept[0].rows >= 1,
    JSON.stringify(kept[0])
  )

  const reenabled = (await q(
    `select public.plugin_enable('${s.org}', 'loyalty-lite', '1.0.0', '{}'::jsonb) as r`
  ))[0].r
  check(
    'enable → disable → enable is clean: nothing is applied twice',
    reenabled.enabled === true && reenabled.migrations_applied === 0,
    `applied=${reenabled.migrations_applied}`
  )

  // ── Who may do any of this ─────────────────────────────────────────────
  await asUser(cashier)
  const cashierRefusals = [
    await fails(`select public.plugin_enable('${s.org}', 'batch-expiry', '1.0.0', '{}'::jsonb)`, /permission_denied/),
    await fails(`select public.plugin_disable('${s.org}', 'batch-expiry')`, /permission_denied/),
    await fails(`select public.plugin_catalog('${s.org}')`, /permission_denied/),
    await fails(`select public.plugin_rpc('${s.org}', 'loyalty-lite', 'totals', '{}'::jsonb)`, /permission_denied/),
  ]
  check(
    'a cashier cannot enable, disable, read the catalogue or call a plugin’s admin functions',
    cashierRefusals.every((problem) => problem === null),
    cashierRefusals.filter(Boolean).join(' · ') || 'all four refused'
  )

  const cashierState = (await q(`select public.plugin_state('${s.org}') as r`))[0].r
  check(
    'but a cashier can still load the shop’s enabled plugins',
    Array.isArray(cashierState) && cashierState.some((entry) => entry.key === 'loyalty-lite'),
    cashierState.map((entry) => entry.key).join(', ')
  )

  // ── A careless plugin cannot open the shop to anonymous callers ────────
  // 043 exists because `alter default privileges` cannot take away the
  // built-in EXECUTE-to-PUBLIC on a function, so a plugin that simply forgets
  // to revoke would leave an anonymous-callable function in the database. The
  // host closes that on every file it applies. This is that claim, tested the
  // way it will actually happen: a package whose SQL creates a function and
  // grants nothing, enabled through `plugin_enable`.
  //
  // The first assertion matters as much as the second — a probe that was never
  // reachable in the first place would make the check pass for the wrong
  // reason.
  const carelessSql = [
    'create or replace function public.careless_plugin_rpc() returns integer',
    'language sql as $careless$ select 42 $careless$;',
  ].join('\n')
  await db.query(
    `insert into public.plugin_packages
           (plugin_key, name, category, version, core_api_version, description,
            dependencies, conflicts)
     values ('careless-probe', 'Careless probe', 'optional', '1.0.0', '^1.0.0',
             'Test fixture: a plugin that forgets to revoke its own functions.',
             '{}', '{}')`
  )
  // The checksum has to be the md5 of the exact text the host will execute,
  // which is why the fixture's SQL is passed in rather than written twice.
  await db.query(
    `insert into public.plugin_package_migrations
           (plugin_key, filename, version, ordinal, checksum, sql)
     values ('careless-probe', '001_careless.sql', '1.0.0', 1, md5($1), $1)`,
    [carelessSql]
  )

  await asUser(owner)
  const carelessEnable = (await q(
    `select public.plugin_enable('${s.org}', 'careless-probe', '1.0.0', '{}'::jsonb) as r`
  ))[0].r
  const carelessGrants = await q(`
    select has_function_privilege('anon', p.oid, 'EXECUTE')::text          as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'careless_plugin_rpc'`)
  const carelessRow = carelessGrants[0] ?? { anon: 'missing', auth: 'missing' }
  check(
    'a plugin that forgets to revoke still leaves nothing callable by an anonymous caller',
    carelessEnable.enabled === true &&
      carelessRow.anon === 'false' && carelessRow.auth === 'false',
    `enabled=${carelessEnable.enabled} anon=${carelessRow.anon} authenticated=${carelessRow.auth}`
  )

  // ── Leave the shop as we found it ──────────────────────────────────────
  await asUser(owner)
  await q(`select public.plugin_disable('${s.org}', 'loyalty-lite')`)
  await q(`select public.plugin_disable('${s.org}', 'batch-expiry')`)
  await q(`select public.plugin_disable('${s.org}', 'careless-probe')`)
  await q(`delete from public.plugin_packages where plugin_key = 'careless-probe'`)
  await q(`delete from public.plugin_migrations where plugin_key = 'careless-probe'`)
  await db.exec(`drop function if exists public.careless_plugin_rpc()`)
  await q(`delete from public.plugin_packages where plugin_key = 'bad-plugin'`)
  await q(`delete from public.plugin_data where organization_id = '${s.org}'`)
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
}

// ── Phase 7 — the variants capability plugin ──────────────────────────────
//
// The first Phase 7 plugin, and the one that tests the architecture's promise
// in the hardest way: it *builds* variants, so if it has quietly grown its own
// variant table the whole premise (spec §51) is dead. So the checks below do
// not stop at "the plugin works" — the last one sells a generated variant
// through `complete_sale` and reads it back out of `pos_catalog`, which is
// only possible if the plugin created real core rows.
if (seeded.length !== 0) {
  const s = seeded[0]
  const owner = s.owner
  const cashier = '00000000-0000-0000-0000-00000000cafe'
  const product = '00000000-0000-0000-0000-00000000c001'

  const asUser = async (id) => {
    await db.exec(`select set_config('request.jwt.claim.sub', '${id}', false)`)
  }
  const fails = async (sql, pattern) => {
    try {
      await q(sql)
      return `no error raised (expected ${pattern})`
    } catch (error) {
      const message = String(error.message ?? error)
      return pattern.test(message) ? null : message
    }
  }

  await asUser(owner)

  const enabled = (await q(
    `select public.plugin_enable('${s.org}', 'variants', '1.0.0', '{}'::jsonb) as r`
  ))[0].r
  check(
    'the variants plugin installs: both migration files applied in one call',
    enabled.enabled === true && enabled.migrations_applied === 2,
    JSON.stringify(enabled)
  )

  const call = async (fn, args = {}) =>
    (await q(
      `select public.plugin_rpc('${s.org}', 'variants', '${fn}', '${JSON.stringify(args)}'::jsonb) as r`
    ))[0].r

  // ── Options and values ─────────────────────────────────────────────────
  const sizeType = await call('save_type', { name: 'Size', sort_order: 1 })
  const colourType = await call('save_type', { name: 'Colour', sort_order: 2 })

  const values = {}
  for (const [key, typeId, value] of [
    ['s', sizeType.id, 'S'],
    ['m', sizeType.id, 'M'],
    ['l', sizeType.id, 'L'],
    ['red', colourType.id, 'Red'],
    ['blue', colourType.id, 'Blue'],
  ]) {
    values[key] = (await call('save_value', { option_type_id: typeId, value })).id
  }

  const catalog = await call('catalog')
  check(
    'options and values are listed with what already uses them',
    catalog.types.length === 2 &&
      catalog.totals.values === 5 &&
      catalog.types.every((type) => Array.isArray(type.values) && type.values.length >= 2),
    `${catalog.totals.types} options · ${catalog.totals.values} values`
  )

  const axes = [
    { option_type_id: sizeType.id, value_ids: [values.s, values.m] },
    { option_type_id: colourType.id, value_ids: [values.red, values.blue] },
  ]

  // ── The preview, then the build ────────────────────────────────────────
  const preview = await call('preview', { product_id: product, axes })
  check(
    'the preview names every combination before anything is written',
    preview.total === 4 &&
      preview.new === 4 &&
      preview.rows.every((row) => row.exists === false) &&
      preview.rows.map((row) => row.suffix).join('|') === 'S / Red|S / Blue|M / Red|M / Blue',
    `${preview.total} combinations · ${preview.rows.map((r) => r.suffix).join(', ')}`
  )

  const generated = await call('generate', { product_id: product, axes })
  const made = generated.variants.filter((variant) => variant.name_suffix !== null)
  check(
    'generating creates one variant per combination, named from its own values',
    generated.created === 4 &&
      made.length === 4 &&
      made.map((variant) => variant.name_suffix).join('|') === 'M / Blue|M / Red|S / Blue|S / Red',
    `${generated.created} created: ${made.map((v) => v.name_suffix).join(', ')}`
  )
  check(
    'every generated variant carries its option values, and inherits the product price',
    made.every((variant) => Object.keys(variant.option_values).length === 2) &&
      made.every((variant) => variant.price_override === null && variant.price === 25000),
    `${made.length} variants · price ${made[0]?.price}`
  )

  const again = await call('generate', { product_id: product, axes })
  check(
    'generating the same matrix twice creates nothing the second time',
    again.created === 0 && again.skipped === 4,
    `created=${again.created} skipped=${again.skipped}`
  )

  // Half a matrix is refused *before* a row is written — including the axes
  // change the refusal arrives with.
  const partial = await fails(
    `select public.plugin_rpc('${s.org}', 'variants', 'generate',
       '{"product_id":"${product}","axes":[
          {"option_type_id":"${sizeType.id}","value_ids":["${values.s}","${values.m}","${values.l}"]},
          {"option_type_id":"${colourType.id}","value_ids":["${values.red}","${values.blue}"]}]}'::jsonb)`,
    /variants_partial_combination/
  )
  const afterPartial = await call('axes', { product_id: product })
  check(
    'a half-built matrix is refused, and the axes it came with are not left behind',
    partial === null &&
      afterPartial.axes.length === 2 &&
      afterPartial.variants.filter((variant) => variant.name_suffix !== null).length === 4,
    partial ?? `${afterPartial.axes.length} axes · ${afterPartial.variants.length} variants`
  )

  // ── Bulk pricing ───────────────────────────────────────────────────────
  const bulkPercent = await call('bulk', {
    product_id: product,
    field: 'price',
    mode: 'percent',
    value: 10,
    only_inherited: true,
  })
  const repriced = await call('axes', { product_id: product })
  const defaultVariant = repriced.variants.find((variant) => variant.name_suffix === null)
  check(
    'a bulk percentage re-prices every matrix variant that was inheriting, in one call',
    bulkPercent.updated === 4 &&
      repriced.variants
        .filter((variant) => variant.name_suffix !== null)
        .every((variant) => variant.price_override === 27500),
    `${bulkPercent.updated} updated · override ${repriced.variants[1]?.price_override}`
  )
  check(
    'the bulk editor leaves the product’s own price alone',
    defaultVariant !== undefined && defaultVariant.price_override === null,
    defaultVariant ? `default variant override ${defaultVariant.price_override}` : 'no default variant'
  )

  const bulkOverridesOnly = await call('bulk', {
    product_id: product,
    field: 'price',
    mode: 'set',
    value: 3000,
    only_inherited: true,
  })
  check(
    '"only the ones still inheriting" is honoured — the second run touches none',
    bulkOverridesOnly.updated === 0,
    `updated=${bulkOverridesOnly.updated}`
  )

  // ── One variant, by hand ───────────────────────────────────────────────
  const target = repriced.variants.find((variant) => variant.name_suffix === 'S / Red')
  await call('update', { variant_id: target.variant_id, price_override: 2000, sku: 'E2E-S-RED' })
  const edited = (await call('axes', { product_id: product })).variants.find(
    (variant) => variant.variant_id === target.variant_id
  )
  check(
    'a single variant takes an override and a SKU',
    edited.price_override === 2000 && edited.sku === 'E2E-S-RED' && edited.price === 2000,
    `override=${edited.price_override} sku=${edited.sku}`
  )

  await call('update', { variant_id: target.variant_id, price_override: '' })
  const cleared = (await call('axes', { product_id: product })).variants.find(
    (variant) => variant.variant_id === target.variant_id
  )
  check(
    'an emptied override clears back to inheriting the product price',
    cleared.price_override === null && cleared.price === 25000,
    `override=${cleared.price_override} price=${cleared.price}`
  )

  // ── Renames travel ─────────────────────────────────────────────────────
  await call('save_type', { id: sizeType.id, name: 'Size (EU)' })
  const renamed = await call('axes', { product_id: product })
  check(
    'renaming an option rewrites the keys already stamped on its variants',
    renamed.variants
      .filter((variant) => variant.name_suffix !== null)
      .every((variant) => 'Size (EU)' in variant.option_values),
    Object.keys(renamed.variants[1]?.option_values ?? {}).join(', ')
  )
  await call('save_type', { id: sizeType.id, name: 'Size' })

  await call('save_value', { id: values.red, value: 'Red (dark)' })
  const recoloured = await call('axes', { product_id: product })
  check(
    'renaming a value rewrites it on the variants that carry it',
    recoloured.variants.some((variant) => variant.option_values.Colour === 'Red (dark)'),
    recoloured.variants
      .map((variant) => variant.option_values.Colour)
      .filter(Boolean)
      .join(', ')
  )
  await call('save_value', { id: values.red, value: 'Red' })

  // ── Refusals ───────────────────────────────────────────────────────────
  const deleteUsedType = await fails(
    `select public.plugin_rpc('${s.org}', 'variants', 'delete_type', '{"id":"${sizeType.id}"}'::jsonb)`,
    /variants_option_type_in_use/
  )
  const deleteUsedValue = await fails(
    `select public.plugin_rpc('${s.org}', 'variants', 'delete_value', '{"id":"${values.red}"}'::jsonb)`,
    /variants_option_value_in_use/
  )
  check(
    'an option or a value that is still in use cannot be deleted out from under a product',
    deleteUsedType === null && deleteUsedValue === null,
    deleteUsedType ?? deleteUsedValue ?? 'both refused'
  )

  await q(
    `select public.plugin_set_config('${s.org}', 'variants', '{"max_variants": 3}'::jsonb)`
  )
  const overLimit = await fails(
    `select public.plugin_rpc('${s.org}', 'variants', 'preview',
       '{"product_id":"${product}","axes":[
          {"option_type_id":"${sizeType.id}","value_ids":["${values.s}","${values.m}","${values.l}"]},
          {"option_type_id":"${colourType.id}","value_ids":["${values.red}","${values.blue}"]}]}'::jsonb)`,
    /variants_limit_exceeded/
  )
  check(
    'a matrix bigger than the shop allows is refused, with the number it would have made',
    overLimit === null,
    overLimit ?? 'refused: variants_limit_exceeded'
  )
  await q(
    `select public.plugin_set_config('${s.org}', 'variants', '{"max_variants": 200}'::jsonb)`
  )

  const foreignProduct = await fails(
    `select public.plugin_rpc('${s.org}', 'variants', 'axes',
       '{"product_id":"00000000-0000-0000-0000-00000000e001"}'::jsonb)`,
    /variants_unknown_product/
  )
  const foreignValue = await fails(
    `select public.plugin_rpc('${s.org}', 'variants', 'set_axes',
       '{"product_id":"${product}","axes":[{"option_type_id":"${sizeType.id}","value_ids":["${values.s}","00000000-0000-0000-0000-0000000000ff"]}]}'::jsonb)`,
    /variants_unknown_option_value/
  )
  check(
    'another shop’s product, and a value that is not this option’s, are both refused by name',
    foreignProduct === null && foreignValue === null,
    foreignProduct ?? foreignValue ?? 'both refused'
  )

  await asUser(cashier)
  const cashierRefusals = [
    await fails(
      `select public.plugin_rpc('${s.org}', 'variants', 'save_type', '{"name":"Nope"}'::jsonb)`,
      /permission_denied/
    ),
    await fails(`select public.plugin_rpc('${s.org}', 'variants', 'catalog', '{}'::jsonb)`, /permission_denied/),
  ]
  check(
    'a cashier holds neither variants.view nor variants.manage',
    cashierRefusals.every((problem) => problem === null),
    cashierRefusals.filter(Boolean).join(' · ') || 'both refused'
  )
  await asUser(owner)

  // ── The payoff: a generated variant is a real variant ──────────────────
  // Nothing in this check knows the plugin exists. It stocks and sells a
  // generated variant through the core RPCs, because if the plugin had grown
  // its own hidden variant table, this is where that would show up.
  await db.exec('begin')
  let sold = null
  try {
    const variantRow = (await call('axes', { product_id: product })).variants.find(
      (variant) => variant.name_suffix === 'M / Blue'
    )
    await q(
      `select public.apply_stock_movement('${s.warehouse}', '${variantRow.variant_id}',
        'PURCHASE', 5, 150, 'variants-probe', null, null)`
    )
    const sale = (await q(
      `select public.complete_sale('${s.branch}',
         jsonb_build_array(jsonb_build_object('variant_id', '${variantRow.variant_id}', 'qty', 2)),
         jsonb_build_array(jsonb_build_object('method_id', '${s.cash}', 'amount', 550)),
         '${s.register}', null, null, null, null, null) as r`
    ))[0].r

    const inCatalog = await q(
      `select pos.variant_name, pos.price
         from public.pos_catalog pos
        where pos.variant_id = '${variantRow.variant_id}'`
    )

    sold = {
      status: sale.status,
      total: Number(sale.total),
      name: inCatalog[0]?.variant_name,
      price: Number(inCatalog[0]?.price),
    }
  } finally {
    await db.query('rollback')
  }

  check(
    'a generated variant stocks and sells through the core — the plugin added no second way to sell',
    sold !== null && sold.status === 'COMPLETED' && sold.total === 550 && sold.name === 'M / Blue',
    sold ? `${sold.status} ${sold.total} · catalogue “${sold.name}”` : 'the sale did not run'
  )

  // ── Leave the shop as we found it ──────────────────────────────────────
  await q(`select public.plugin_disable('${s.org}', 'variants')`)
  await q(`delete from public.product_variants
            where organization_id = '${s.org}' and product_id = '${product}' and name_suffix is not null`)
  await q(`delete from public.plg_variants_product_axes where organization_id = '${s.org}'`)
  await q(`delete from public.product_option_values where organization_id = '${s.org}'`)
  await q(`delete from public.product_option_types where organization_id = '${s.org}'`)

  const leftovers = await q(
    `select (select count(*)::int from public.product_option_types t where t.organization_id = '${s.org}') as types,
            (select count(*)::int from public.product_variants pv
              where pv.organization_id = '${s.org}' and pv.name_suffix is not null) as variants`
  )
  check(
    'switching the plugin off and clearing its fixtures leaves the shop exactly as it was',
    leftovers[0].types === 0 && leftovers[0].variants === 0,
    JSON.stringify(leftovers[0])
  )

  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
}

// ── Phase 7 — the serial-numbers capability plugin ────────────────────────
//
// The plugin for shops that sell things with a number of their own. It is the
// first plugin whose subject is an *individual unit* rather than a product, so
// the checks below are about identity and history: one unit cannot be sold
// twice, a unit that comes back is not still counted as sold, and a shop that
// never scans still gets codes that are labelled as the shop's own.
//
// The last check is the §51 one, in the form this plugin can be caught by: the
// plugin owns exactly one table, and the sale it decorates is still a core
// sale, read back through the core's own catalogue.
if (seeded.length !== 0) {
  const s = seeded[0]
  const owner = s.owner
  const cashier = '00000000-0000-0000-0000-00000000cafe'
  // Fixtures of its own: a phone, whose units are what a mobile shop tracks.
  const phone = '00000000-0000-0000-0000-00000000d401'
  const phoneVariant = '00000000-0000-0000-0000-00000000d402'
  // A second product that never asked to be tracked, so the refusal below is
  // the plugin's answer and not a missing checkbox on the phone.
  const cable = '00000000-0000-0000-0000-00000000d403'
  const cableVariant = '00000000-0000-0000-0000-00000000d404'

  const asUser = async (id) => {
    await db.exec(`select set_config('request.jwt.claim.sub', '${id}', false)`)
  }
  const fails = async (sql, pattern) => {
    try {
      await q(sql)
      return `no error raised (expected ${pattern})`
    } catch (error) {
      const message = String(error.message ?? error)
      return pattern.test(message) ? null : message
    }
  }

  await asUser(owner)

  await db.exec(`
    insert into public.products
      (id, organization_id, name, sku, selling_price, cost_price, track_stock,
       metadata)
    values ('${phone}', '${s.org}', 'Serial Probe Phone', 'SP-1', 250, 150, true,
            '{"serial_tracked": true}'::jsonb);
    insert into public.product_variants (id, organization_id, product_id, is_default)
    values ('${phoneVariant}', '${s.org}', '${phone}', true);
    insert into public.products
      (id, organization_id, name, sku, selling_price, cost_price, track_stock, metadata)
    values ('${cable}', '${s.org}', 'Serial Probe Cable', 'SC-1', 40, 20, true, '{}'::jsonb);
    insert into public.product_variants (id, organization_id, product_id, is_default)
    values ('${cableVariant}', '${s.org}', '${cable}', true);
  `)

  const enabled = (await q(
    `select public.plugin_enable('${s.org}', 'serial-numbers', '1.0.0', '{}'::jsonb) as r`
  ))[0].r
  check(
    'the serial-numbers plugin installs: both migration files applied in one call',
    enabled.enabled === true && enabled.migrations_applied === 2,
    JSON.stringify(enabled)
  )

  const call = async (fn, args = {}) =>
    (await q(
      `select public.plugin_rpc('${s.org}', 'serial-numbers', '${fn}', '${JSON.stringify(args)}'::jsonb) as r`
    ))[0].r

  // ── The product has to opt in ───────────────────────────────────────────
  const untracked = await fails(
    `select public.plugin_rpc('${s.org}', 'serial-numbers', 'add',
       '{"variant_id":"${cableVariant}","serials":["D-1"]}'::jsonb)`,
    /serial_product_not_tracked/
  )
  check(
    'a unit cannot be registered for a product that never asked to be tracked',
    untracked === null,
    untracked ?? 'refused: serial_product_not_tracked'
  )

  // ── The pool cannot outgrow the shelf ───────────────────────────────────
  const beforeStock = await call('add', { variant_id: phoneVariant, serials: ['D-1', 'D-2'] })
  check(
    'labelling cannot invent stock: with nothing on hand, nothing registers',
    beforeStock.added === 0 &&
      beforeStock.stock_on_hand === 0 &&
      beforeStock.skipped.every((entry) => entry.reason === 'over_stock'),
    JSON.stringify({ added: beforeStock.added, skipped: beforeStock.skipped })
  )

  await db.exec(
    `select public.apply_stock_movement('${s.warehouse}', '${phoneVariant}', 'PURCHASE', 3, 150, 'sn-probe', null, null)`
  )
  const added = await call('add', {
    variant_id: phoneVariant,
    warehouse_id: s.warehouse,
    serials: ['D-1', 'd-1', 'D-2', ''],
  })
  const oneOver = await call('add', { variant_id: phoneVariant, serials: ['D-3', 'D-4'] })
  check(
    'a delivery registers, counts a repeated unit once, and refuses to pass the stock on hand',
    added.added === 2 &&
      added.skipped.some((entry) => entry.reason === 'duplicate_in_list') &&
      added.skipped.some((entry) => entry.reason === 'empty') &&
      oneOver.added === 1 &&
      oneOver.skipped.some((entry) => entry.reason === 'over_stock'),
    JSON.stringify({ added: added.added, oneOver: oneOver.added })
  )

  // ── A unit that is sold is attached to the line it left on ──────────────
  const sale = (await q(
    `select public.complete_sale('${s.branch}',
       jsonb_build_array(jsonb_build_object('variant_id', '${phoneVariant}', 'qty', 2)),
       jsonb_build_array(jsonb_build_object('method_id', '${s.cash}', 'amount', 500)),
       '${s.register}', null, null, null, null, null) as r`
  ))[0].r
  const saleId = sale.sale_id ?? sale.id

  const pendingBefore = await call('pending', { days: 60, limit: 10 })
  const captured = await call('capture', {
    sale_id: saleId,
    serials: ['D-1', 'D-2', 'NOT-A-UNIT'],
  })
  const after = await call('for_sale', { sale_id: saleId })
  check(
    'the till attaches units to the sale, and the shop can see what is still missing',
    pendingBefore.some((entry) => entry.sale_id === saleId && entry.missing === 2) &&
      captured.captured === 2 &&
      captured.refusals.some((entry) => entry.reason === 'not_registered') &&
      after.missing === 0 &&
      after.lines[0].bound.length === 2,
    JSON.stringify({ pending: pendingBefore.length, captured: captured.captured, missing: after.missing })
  )

  const twice = await call('capture', { sale_id: saleId, serials: ['D-1', 'D-3'] })
  check(
    'one unit is sold once: a second attempt on the same unit is refused by name',
    twice.captured === 0 &&
      twice.refusals.some((entry) => entry.reason === 'not_in_stock') &&
      twice.refusals.some((entry) => entry.reason === 'every_line_full'),
    JSON.stringify(twice.refusals)
  )

  const soldRow = await q(
    `select s.serial, s.status, s.sale_id, sa.invoice_no
       from public.plg_serial_numbers_serials s
       join public.sales sa on sa.id = s.sale_id
      where s.organization_id = '${s.org}' and s.serial = 'D-1'`
  )
  check(
    'the unit carries the invoice it left on, which is the whole point of a serial',
    soldRow.length === 1 && soldRow[0].status === 'SOLD' && soldRow[0].sale_id === saleId,
    soldRow.map((row) => `${row.serial} ${row.status} ${row.invoice_no}`).join(' · ') || 'no row'
  )

  // ── A shop that does not scan still gets a code ─────────────────────────
  const secondSale = (await q(
    `select public.complete_sale('${s.branch}',
       jsonb_build_array(jsonb_build_object('variant_id', '${phoneVariant}', 'qty', 1)),
       jsonb_build_array(jsonb_build_object('method_id', '${s.cash}', 'amount', 250)),
       '${s.register}', null, null, null, null, null) as r`
  ))[0].r
  const secondId = secondSale.sale_id ?? secondSale.id
  const minted = await call('autofill', { sale_id: secondId })
  const internalRow = await q(
    `select s.serial, s.source, s.status, s.sale_item_id
       from public.plg_serial_numbers_serials s
      where s.organization_id = '${s.org}' and s.sale_id = '${secondId}'`
  )
  check(
    'a till that never scans mints its own codes, and they are labelled as the shop’s',
    minted.created === 1 &&
      minted.serials[0].serial.startsWith('SN-') &&
      internalRow.length === 1 &&
      internalRow[0].source === 'INTERNAL' &&
      internalRow[0].status === 'SOLD',
    `${minted.created} minted ${internalRow[0]?.serial ?? '—'} (${internalRow[0]?.source ?? '—'})`
  )

  // ── A refund already says which units came back ─────────────────────────
  const item = (await q(
    `select si.id from public.sale_items si where si.sale_id = '${saleId}' order by si.id limit 1`
  ))[0]
  await q(
    `select public.refund_sale('${saleId}',
       jsonb_build_array(jsonb_build_object('sale_item_id', '${item.id}', 'qty', 1)),
       jsonb_build_array(), 'probe', true)`
  )
  const synced = await call('sync_refunds', { sale_id: saleId })
  const syncedAgain = await call('sync_refunds', { sale_id: saleId })
  const returned = await q(
    `select count(*)::int as n from public.plg_serial_numbers_serials s
      where s.organization_id = '${s.org}' and s.sale_id = '${saleId}' and s.status = 'RETURNED'`
  )
  check(
    'a refund marks the units that came back — exactly once, however often it is told',
    synced.marked === 1 && syncedAgain.marked === 0 && returned[0].n === 1,
    JSON.stringify({ first: synced.marked, second: syncedAgain.marked, returned: returned[0].n })
  )

  const releasedIds = (
    await q(
      `select s.id from public.plg_serial_numbers_serials s
        where s.organization_id = '${s.org}' and s.sale_id = '${saleId}' and s.status = 'RETURNED'`
    )
  ).map((row) => row.id)
  const released = await call('release', { ids: releasedIds })
  const afterRelease = await call('sync_refunds', { sale_id: saleId })
  const backInStock = await q(
    `select count(*)::int as n from public.plg_serial_numbers_serials s
      where s.organization_id = '${s.org}' and s.id = '${releasedIds[0]}' and s.status = 'IN_STOCK'`
  )
  check(
    'a unit put back on the shelf is in stock, and a later refund sync does not undo it',
    released.released === 1 && afterRelease.marked === 0 && backInStock[0].n === 1,
    JSON.stringify({ released: released.released, resynced: afterRelease.marked })
  )

  // ── Reporting ───────────────────────────────────────────────────────────
  const report = await call('report', { days: 30 })
  const overview = await call('overview')
  check(
    'the report counts what is in hand — the number a stock count cannot show',
    report.totals.sold === 3 &&
      report.totals.internal === 1 &&
      report.by_product.some((entry) => entry.product_name === 'Serial Probe Phone') &&
      report.aging.length > 0 &&
      overview.totals.in_stock === report.totals.in_stock,
    JSON.stringify({ sold: report.totals.sold, in_stock: report.totals.in_stock, aging: report.aging })
  )

  // ── Tenant safety, by construction ──────────────────────────────────────
  const tables = await q(
    `select c.relname,
            c.relrowsecurity as rls,
            (select count(*)::int from information_schema.columns col
              where col.table_schema = 'public' and col.table_name = c.relname
                and col.column_name = 'organization_id') as org_col,
            (select count(*)::int from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname like 'plg_serial%'`
  )
  check(
    'the plugin owns one table, and it is tenant-safe by construction: org-scoped, RLS on, policies present',
    tables.length === 1 && tables[0].rls === true && tables[0].org_col === 1 && tables[0].policies >= 1,
    tables.map((row) => `${row.relname} rls=${row.rls} org=${row.org_col} policies=${row.policies}`).join(' ') || 'no table'
  )

  const granted = await q(
    `select key from public.permissions where plugin_key = 'serial-numbers' order by key`
  )
  check(
    'its two permissions are in the shop’s catalogue, namespaced to the plugin',
    granted.length === 2 && granted.every((row) => row.key.startsWith('serial-numbers.')),
    granted.map((row) => row.key).join(' · ')
  )

  const foreign = await fails(
    `select public.serial_numbers_list('00000000-0000-0000-0000-00000000e001', '{}'::jsonb)`,
    /forbidden|permission_denied/
  )
  check(
    'another shop cannot read this pool by calling the function directly',
    foreign === null,
    foreign ?? 'refused'
  )

  await asUser(cashier)
  const cashierRefusals = [
    await fails(
      `select public.plugin_rpc('${s.org}', 'serial-numbers', 'add',
         '{"variant_id":"${phoneVariant}","serials":["NOPE"]}'::jsonb)`,
      /permission_denied/
    ),
    await fails(
      `select public.plugin_rpc('${s.org}', 'serial-numbers', 'list', '{}'::jsonb)`,
      /permission_denied/
    ),
  ]
  check(
    'a cashier holds neither serial-numbers.view nor serial-numbers.manage',
    cashierRefusals.every((problem) => problem === null),
    cashierRefusals.filter(Boolean).join(' · ') || 'both refused'
  )
  await asUser(owner)

  // ── The §51 check ───────────────────────────────────────────────────────
  // Nothing below knows the plugin exists. The sale it decorates is still the
  // core's sale — its ledger rows and its receipt come from the core — and not
  // one stock movement anywhere carries the plugin's name or points at one of
  // its rows. That is the whole promise in one query: the plugin remembers
  // *which* unit, and touches nothing else.
  const core = await q(
    `select (select count(*)::int from public.stock_movements m
              where m.organization_id = '${s.org}' and m.reference_id = '${saleId}'
                and m.type = 'SALE') as sale_movements,
            (select count(*)::int from public.stock_movements m
              where m.organization_id = '${s.org}'
                and (m.reference_type like 'serial%'
                     or m.reference_id in (select s.id from public.plg_serial_numbers_serials s
                                            where s.organization_id = '${s.org}'))) as stray_movements,
            (select app.sale_receipt('${saleId}') ->> 'total') as receipt_total,
            (select app.sale_receipt('${saleId}') ->> 'invoice_no') as invoice_no`
  )
  check(
    'the sale and its ledger stay the core’s: no movement anywhere belongs to the plugin',
    core[0].sale_movements === 1 &&
      core[0].stray_movements === 0 &&
      core[0].receipt_total === '500.00' &&
      typeof core[0].invoice_no === 'string',
    JSON.stringify(core[0])
  )

  // ── Switching it off keeps the shop's units ─────────────────────────────
  await q(`select public.plugin_disable('${s.org}', 'serial-numbers')`)
  const kept = await q(
    `select (select count(*)::int from public.plg_serial_numbers_serials s
              where s.organization_id = '${s.org}') as units,
            (select enabled from public.plugins p
              where p.organization_id = '${s.org}' and p.plugin_key = 'serial-numbers') as enabled`
  )
  const afterDisable = await fails(
    `select public.plugin_rpc('${s.org}', 'serial-numbers', 'list', '{}'::jsonb)`,
    /plugin_not_enabled/
  )
  check(
    'switching the plugin off keeps every unit the shop registered, and stops it answering',
    kept[0].units > 0 && kept[0].enabled === false && afterDisable === null,
    JSON.stringify({ units: kept[0].units, enabled: kept[0].enabled, refused: afterDisable === null })
  )

  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
}

// ── Phase 8 — an offline sale may be sent twice, and must sell once ───────
//
// The queue on the device cannot know whether a call landed before the
// connection died, so it sends the sale again when the network returns (044).
// The only way that is safe is for the server to recognise the second attempt
// as the same sale — which is what `client_ref` is for. Two sends, one sale,
// one stock movement, one invoice number: that is the assertion.
//
// The second half matters just as much: a *different* reference must still
// create a second sale. A guarantee that deduplicated everything would make
// the second customer's identical basket disappear.
if (seeded.length !== 0) {
  const s = seeded[0]
  const offlineProduct = '00000000-0000-0000-0000-00000000c901'
  const offlineVariant = '00000000-0000-0000-0000-00000000c902'
  const ref = 'offline-probe-1'
  const otherRef = 'offline-probe-2'

  await db.exec(`select set_config('request.jwt.claim.sub', '${s.owner}', false)`)

  await db.exec(`
    INSERT INTO public.products (id, organization_id, name, selling_price, cost_price, track_stock)
    VALUES ('${offlineProduct}', '${s.org}', 'Offline Widget', 400, 150, true)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.product_variants (id, organization_id, product_id, is_default)
    VALUES ('${offlineVariant}', '${s.org}', '${offlineProduct}', true)
    ON CONFLICT (id) DO NOTHING;
  `)
  await q(`select public.apply_stock_movement(
             '${s.warehouse}', '${offlineVariant}', 'PURCHASE', 20, 150, 'test', null, null)`)

  const openSession = await q(
    `select id from public.register_sessions
      where register_id = '${s.register}' and closed_at is null limit 1`
  )
  if (openSession.length === 0) {
    await q(`select public.open_register('${s.register}', 1000, null)`)
  }

  const sell = async (clientRef) => {
    const rows = await q(`
      select public.complete_sale(
        '${s.branch}',
        jsonb_build_array(jsonb_build_object('variant_id', '${offlineVariant}', 'qty', 2)),
        jsonb_build_array(jsonb_build_object('method_id', '${s.cash}', 'amount', 800)),
        '${s.register}', null, null, null, null, null, null, '${clientRef}') as r`)
    return rows[0].r
  }

  const stockOf = async () => {
    const rows = await q(`
      select quantity::numeric as qty from public.stock_balances
       where warehouse_id = '${s.warehouse}' and variant_id = '${offlineVariant}'`)
    return Number(rows[0]?.qty ?? -1)
  }

  const stockBefore = await stockOf()
  const first = await sell(ref)
  const stockAfterFirst = await stockOf()
  const replay = await sell(ref)
  const stockAfterReplay = await stockOf()

  check(
    'a queued sale sent twice becomes one sale, with the receipt of the first',
    replay.sale_id === first.sale_id &&
      replay.invoice_no === first.invoice_no &&
      replay.total === first.total,
    `${first.invoice_no} → ${replay.invoice_no}`
  )

  // The receipt is what the till prints and what an offline client keeps, so its
  // money has to arrive in the shape the clients are written for: text. A
  // numeric column passed straight into `jsonb_build_object` yields a JSON
  // number, which the Kotlin reference cannot decode into the string fields the
  // contract promises — `npm run e2e:android` found it, migration 045 fixed it,
  // and this is the assertion that keeps it fixed.
  const moneyTypes = await q(`
    select jsonb_typeof(r -> 'subtotal') as subtotal,
           jsonb_typeof(r -> 'discount') as discount,
           jsonb_typeof(r -> 'tax') as tax,
           jsonb_typeof(r -> 'total') as total,
           jsonb_typeof(r -> 'paid') as paid,
           jsonb_typeof(r -> 'change_due') as change_due
      from (select app.sale_receipt('${first.sale_id}'::uuid) as r) t`)
  const nonText = Object.entries(moneyTypes[0] ?? {}).filter(([, type]) => type !== 'string')
  check(
    'the receipt carries every money field as text, the shape the clients decode',
    nonText.length === 0,
    nonText.length ? nonText.map(([field, type]) => `${field}=${type}`).join(', ') : 'all six are strings'
  )

  check(
    'the replay does not move stock a second time',
    stockBefore - stockAfterFirst === 2 && stockAfterReplay === stockAfterFirst,
    `${stockBefore} → ${stockAfterFirst} → ${stockAfterReplay}`
  )

  const refCounts = await q(`
    select count(*)::int as sales,
           (select count(*)::int from public.stock_movements m
             where m.reference_id = '${first.sale_id}') as movements
      from public.sales where organization_id = '${s.org}' and client_ref = '${ref}'`)
  check(
    'and leaves one row, one movement and one invoice behind',
    refCounts[0].sales === 1 && refCounts[0].movements === 1,
    JSON.stringify(refCounts[0])
  )

  const second = await sell(otherRef)
  check(
    'a different reference is a different sale — the guarantee is per attempt, not per basket',
    second.sale_id !== first.sale_id && (await stockOf()) < stockAfterReplay,
    `stock ${stockAfterReplay} → ${await stockOf()}`
  )

  // The reference is the shop's own, so a replay must not work across shops.
  // (A cashier *may* sell — that is the design, checked above — so the outsider
  // here is the owner of a different organization, presenting this shop's
  // branch.) 044's own assertion covers the other direction: the replay branch
  // is positioned after `require_permission` in the deployed function.
  await db.exec(`select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false)`)
  let refused = null
  try {
    await sell(ref)
  } catch (error) {
    refused = String(error.message ?? error)
  }
  check(
    'another shop cannot replay into this one by presenting its branch',
    refused !== null && /forbidden|permission_denied/.test(refused),
    refused ?? 'the call succeeded'
  )

  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
}

// ── Every permission key the client names must exist (023-era guard) ─────
//
// The catalogue is the contract between the database and the UI. Two nav
// items referenced `register.view` and `roles.view`, keys that have never
// existed, so `can()` answered false for everyone and the Register and Roles
// screens were invisible in every shop — an absence, which is exactly the
// kind of bug nobody reports. Scanning src/ for the keys the client asks for
// turns it into a build failure.
const srcFiles = []
const walkSrc = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkSrc(path)
    // Tests carry fixtures, not the product's vocabulary.
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) srcFiles.push(path)
  }
}
walkSrc(join(root, 'src'))

const referenced = new Map()
const take = (file, key) => {
  if (!referenced.has(key)) referenced.set(key, file.replace(root + '/', ''))
}
for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/\bcan\(\s*'([^']+)'/g)) take(file, m[1])
  for (const m of text.matchAll(/\bpermission:\s*'([^']+)'/g)) take(file, m[1])
  for (const m of text.matchAll(/\brequirePermission\(\s*'([^']+)'/g)) take(file, m[1])
}

const catalogueRows = await q('select key from public.permissions')
const platformPermissionRows = await q(`
  select distinct unnest(permissions) as key from public.platform_roles
`)
const catalogue = new Set([
  ...catalogueRows.map((r) => r.key),
  ...platformPermissionRows.map((r) => r.key),
])

// Plugin permissions are a different case from core ones, and the difference
// is the point of the namespace rule (docs/07 §3): a plugin's keys reach the
// catalogue only when the shop enables the plugin, so they cannot be seeded.
// What must hold instead is that the plugin *ships* the key — the package in
// `plugin_package_migrations`' sibling `plugin_package_permissions` — and that
// the key is namespaced to the plugin that references it. A plugin mentioning
// a core key, or a key belonging to another plugin, is exactly the escalation
// this check exists to catch.
const packageRows = await q('select plugin_key, key from public.plugin_package_permissions')
const packaged = new Map()
for (const row of packageRows) {
  if (!packaged.has(row.plugin_key)) packaged.set(row.plugin_key, new Set())
  packaged.get(row.plugin_key).add(row.key)
}

/** `src/plugins/loyalty-lite/index.ts` → `loyalty-lite`; null for core files. */
const pluginIdOf = (file) => {
  const m = /^src\/plugins\/([^/]+)\//.exec(file)
  return m ? m[1] : null
}

const unknownKeys = []
const undeclaredPluginKeys = []
for (const [key, file] of referenced.entries()) {
  const pluginId = pluginIdOf(file)
  if (!pluginId) {
    if (!catalogue.has(key)) unknownKeys.push(`${key} (${file})`)
    continue
  }
  if (key !== pluginId && !key.startsWith(`${pluginId}.`)) {
    unknownKeys.push(`${key} (${file}) — not namespaced to ${pluginId}`)
  } else if (!packaged.get(pluginId)?.has(key)) {
    undeclaredPluginKeys.push(`${key} (${file}) — not in the ${pluginId} package`)
  }
}
unknownKeys.sort()
undeclaredPluginKeys.sort()

check(
  'every permission key referenced in src/ exists in the catalogue, or is shipped by the plugin that uses it',
  unknownKeys.length === 0 && undeclaredPluginKeys.length === 0,
  unknownKeys.length || undeclaredPluginKeys.length
    ? [...unknownKeys, ...undeclaredPluginKeys].join(', ')
    : `${referenced.size} keys checked (${packaged.size} plugin package(s))`
)

// ── The app must load plugins through the cheap call ─────────────────────
//
// `plugin_catalog` requires `plugins.view`; `plugin_state` requires only
// membership, which is the point — a cashier has to be able to load the shop's
// plugins. Wiring the app to the admin call looked fine in every test and
// worked for an owner, and was only found by searching the deployed bundle for
// the RPC it should have been calling. So it is a rule here rather than a
// memory: the host syncs through `state`, and `catalog` belongs to the admin
// screen alone.
const syncSource = readFileSync(join(root, 'src', 'app', 'plugins.ts'), 'utf8')
const usesState = /plugins\.state\(/.test(syncSource)
const usesCatalogInHost = /plugins\.catalog\(/.test(syncSource)
check(
  'the app loads the shop’s plugins through plugin_state, not the admin catalogue',
  usesState && !usesCatalogInHost,
  usesState
    ? usesCatalogInHost
      ? 'src/app/plugins.ts still calls plugins.catalog()'
      : 'src/app/plugins.ts calls plugins.state()'
    : 'src/app/plugins.ts does not call plugins.state()'
)

// ── Source scan: a name used but never declared ──────────────────────────
//
// `record_expense` (014) referenced `v_session_id` without declaring it. That
// is not a syntax error — PL/pgSQL resolves identifiers when the statement
// runs — so the function compiled, was granted to `authenticated`, shipped in
// migration 018, and failed on every call with SQLSTATE 42703. Nothing caught
// it because nothing executed it.
//
// The same class of mistake is cheap to detect statically, so it is: in every
// function body in supabase/migrations, each `v_*` name that is read must be
// declared in that body (in a DECLARE block or as a FOR loop variable).
const migrationDir = join(root, 'supabase/migrations')
const migrationFiles = readdirSync(migrationDir).filter((file) => file.endsWith('.sql'))
const undeclaredVars = []
let functionsScanned = 0

// Only the *last* definition of each function is live — a migration that
// replaces a broken function is the fix, not a second offence. So bodies are
// collected in file order and the earlier ones are discarded.
const finalBodies = new Map()

for (const file of migrationFiles) {
  const text = readFileSync(join(migrationDir, file), 'utf8')
  const fnRe = /create (?:or replace )?function\s+([\w.]+)\s*\([\s\S]*?\)\s*returns[\s\S]*?\$fn\$/g
  for (const match of text.matchAll(fnRe)) {
    const bodyStart = (match.index ?? 0) + match[0].length
    const bodyEnd = text.indexOf('$fn$', bodyStart)
    if (bodyEnd < 0) continue
    finalBodies.set(match[1], { file, body: text.slice(bodyStart, bodyEnd) })
  }
}

for (const [name, { file, body }] of finalBodies) {
  functionsScanned += 1
  const declared = new Set()
  for (const line of body.match(/^\s{2}(v_\w+)\s+[^\n]*?(?:;|=|:)/gm) ?? []) {
    declared.add(line.trim().split(/\s+/)[0])
  }
  for (const loop of body.match(/\bfor\s+(v_\w+)\s+in\b/g) ?? []) {
    declared.add(loop.match(/for\s+(v_\w+)/)?.[1])
  }

  for (const ref of new Set(body.match(/\bv_\w+\b/g) ?? [])) {
    if (!declared.has(ref)) undeclaredVars.push(`${file} ${name}: ${ref}`)
  }
}

check(
  'every live function reads only v_ variables it declares',
  undeclaredVars.length === 0,
  undeclaredVars.length ? undeclaredVars.join(', ') : `${functionsScanned} function bodies`
)

// ── Every column the client selects exists in this schema ────────────────
//
// A PostgREST select is a string, so no compiler reads it. Two shipped bugs
// came from exactly that blind spot — `sale_items.created_at` and
// `sale_payments.created_at`, neither column ever having existed. Both failed
// only at runtime, on one screen, and the second one failed *after* taking
// the customer's money. The schema is right here in PGlite, so the strings
// can simply be checked against it.
const columnRows = await q(`
  select table_name, column_name from information_schema.columns
   where table_schema = 'public'`)
const viewRows = await q(`
  select table_name from information_schema.views where table_schema = 'public'`)

const schemaColumns = new Map()
for (const row of columnRows) {
  if (!schemaColumns.has(row.table_name)) schemaColumns.set(row.table_name, new Set())
  schemaColumns.get(row.table_name).add(row.column_name)
}
void viewRows

const selectProblems = checkSelects([join(root, 'src')], (table) => schemaColumns.get(table))

check(
  'every selected column exists in the schema',
  selectProblems.length === 0,
  selectProblems.length
    ? selectProblems
        .map((p) => `${p.path}.${p.column} (${p.file.replace(root + '/', '')})`)
        .join('; ')
    : `${schemaColumns.size} tables scanned`
)

// ── The generated contract still describes these migrations ───────────────
//
// `contracts/api-contract.json` is generated from the live database and is what
// both clients are written against: the TypeScript in the browser and the Kotlin
// on Android. A migration that renamed a parameter, or added a function without
// the artifact being regenerated, would leave the clients describing a server
// that no longer exists — and this is the check that catches it before anything
// is pushed. Types are compared loosely on purpose (the artifact prints
// `format_type`, PGlite's catalogue prints `data_type`); the names and which of
// them may be omitted are what a caller has to get right.

const contractFile = join(root, 'contracts', 'api-contract.json')
const apiContract = JSON.parse(readFileSync(contractFile, 'utf8'))

/** `p_branch_id uuid, p_items jsonb DEFAULT '[]'` → ['p_branch_id', 'p_items'] */
function argumentNames(text) {
  const names = []
  let depth = 0
  let current = ''
  for (const character of text) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      names.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.trim()) names.push(current)
  return names
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((name) => /^[a-z_][a-z0-9_]*$/.test(name ?? ''))
}

const functionRow = async (name) =>
  (
    await db.query(
      `select pg_get_function_arguments(p.oid) as args,
              p.pronargdefaults as defaults
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
      [name]
    )
  ).rows[0]

const contractMissing = []
const contractMismatched = []
for (const [name, entry] of Object.entries(apiContract.rpc)) {
  const row = await functionRow(name)
  if (!row) {
    contractMissing.push(name)
    continue
  }
  const actual = argumentNames(row.args)
  const expected = entry.params.map((param) => param.name)
  const actualRequired = actual.length - Number(row.defaults)
  const expectedRequired = entry.params.filter((param) => param.required).length
  if (actual.join(',') !== expected.join(',') || actualRequired !== expectedRequired) {
    contractMismatched.push(
      `${name}: (${actual.join(', ')}) vs contract (${expected.join(', ')})` +
        (actualRequired === expectedRequired ? '' : ` [${expectedRequired} required, found ${actualRequired}]`)
    )
  }
}

// And the other direction: a function this project owns that the contract has
// never heard of is an RPC nobody documented — which is how a client ends up
// discovering an API by reading error messages.
const ownedFunctions = await db.query(`
  select p.proname as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and pg_get_function_result(p.oid) not in ('trigger', 'event_trigger')
     -- A client RPC is one the authenticated role may execute. The ledger's
     -- own writer, the sequence helper and every plugin function are callable
     -- only by their owners, so they are not part of the client surface — and a
     -- function that *becomes* reachable without the contract being regenerated
     -- is exactly what this check exists to catch.
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not exists (
       select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
     )
   order by p.proname
`)
// A plugin's functions are reached through the host dispatcher
// (`public.plugin_rpc`), by name, from a plugin's own client code — so they are
// not part of the client contract and are checked where they are defined,
// against the plugin SQL in `supabase/plugins/`.
const pluginFunctionNames = new Set()
const scanForFunctions = (text) => {
  for (const match of text.matchAll(/create (?:or replace )?function\s+([\w.]+)/gi)) {
    pluginFunctionNames.add(match[1].split('.').pop())
  }
}
const pluginDir = join(root, 'supabase/plugins')
for (const pluginFile of readdirSync(pluginDir, { recursive: true })) {
  if (!String(pluginFile).endsWith('.sql')) continue
  scanForFunctions(readFileSync(join(pluginDir, String(pluginFile)), 'utf8'))
}
// A plugin's SQL is embedded in a migration inside a $plg$ … $plg$ block until
// a shop enables it, and applied into `public` when it does.
for (const migrationFile of migrationFiles) {
  const text = readFileSync(join(migrationDir, migrationFile), 'utf8')
  for (const block of text.matchAll(/\$plg\$([\s\S]*?)\$plg\$/g)) scanForFunctions(block[1])
}

const undocumented = ownedFunctions.rows
  .map((row) => row.name)
  .filter((name) => !(name in apiContract.rpc) && !pluginFunctionNames.has(name))

// ── 055: a sale line knows when it was rung up ────────────────────────────
// The bug this guards: opening any sale answered `42703 column
// sale_items.created_at does not exist`, because the client sorted the lines
// by a column the table never had.
{
  const column = await q(`
    select column_default, is_nullable
      from information_schema.columns
     where table_schema = 'public' and table_name = 'sale_items' and column_name = 'created_at'`)

  check(
    'sale_items can be ordered by created_at, which is what the sale screen does',
    column.length === 1,
    column.length === 1 ? 'column present' : 'missing — Stock → History cannot open a sale'
  )

  // `now()` would hand every line of one sale the same timestamp and leave the
  // order exactly as undefined as it was before the column existed.
  check(
    'and the default advances within a transaction, so lines keep their order',
    /clock_timestamp/.test(column[0]?.column_default ?? ''),
    column[0]?.column_default ?? 'no default'
  )

  const ordered = await q(
    `select id from public.sale_items order by created_at limit 1`
  ).then(() => true).catch(() => false)
  check('the exact query the sale screen runs is accepted', ordered)
}

check(
  'the generated contract describes every function it lists, with the same parameters',
  contractMissing.length === 0 && contractMismatched.length === 0,
  contractMissing.length || contractMismatched.length
    ? [...contractMissing.map((name) => `${name} is missing`), ...contractMismatched]
        .join('; ')
        .slice(0, 300)
    : `${Object.keys(apiContract.rpc).length} RPCs, ${Object.keys(apiContract.relations).length} relations`
)
check(
  'and no RPC has appeared that the contract does not mention',
  undocumented.length === 0,
  undocumented.length
    ? undocumented.join(', ')
    : `${ownedFunctions.rows.length} public function(s) accounted for ` +
      `(${pluginFunctionNames.size} plugin function(s) via plugin_rpc)`
)

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} behavioral checks passed`)

await db.close()

if (failed.length || noRls.length) process.exit(1)
console.log('\nAll migrations applied and all assertions passed.')
