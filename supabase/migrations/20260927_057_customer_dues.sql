-- 057 — The due ledger (baki khata), and the label-printing package.
--
-- ── The gap ───────────────────────────────────────────────────────────────
-- The schema has been ready for credit sales since 009: `customers.balance`
-- exists, `complete_sale` marks an underpaid sale PARTIALLY_PAID, and the
-- customers screen already prints an "Owes" figure. But nothing ever *wrote*
-- the balance and nothing could collect it — the single most-used feature of
-- shop software here ("baki khata": sell on credit, track who owes what,
-- collect in parts) was schema-complete and workflow-absent, exactly the
-- shape docs/13 P4-1 had.
--
-- Three pieces close it, all server-side, because a due is money and money
-- is not maintained by a screen:
--
--   1. `customers.balance` becomes a *consequence* of the sales rows. A
--      trigger keeps it equal to the sum of each customer's outstanding
--      dues, so no code path — the till, the offline replay, a refund, this
--      migration's own RPC — can forget to move it. The balance is derived,
--      never narrated.
--
--   2. A credit sale must name its debtor. A PARTIALLY_PAID sale with no
--      customer is a due nobody can ever collect, so the database refuses
--      it the same way it refuses negative stock.
--
--   3. `collect_customer_payment` is the collection: money in, oldest sale
--      first, each taka traceable to the invoice it paid down — mirroring
--      `apply_payment` (025), which is the same book kept for suppliers.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Label printing, seeded as a package (the pattern of 056)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Like Printer Setup and Barcode Scanner it owns no table and ships no SQL:
-- the barcode arithmetic and the paper both live in the bundle, and the
-- screen is gated on `products.view` — whoever may see the products may put
-- their SKUs on paper. The package row exists so the Plugins screen can
-- list it like every other plugin. Free, permanently: charging for the
-- label would be charging for the scanner working.

insert into public.plugin_packages
      (plugin_key, name, category, version, core_api_version, description,
       dependencies, conflicts)
values
  ('label-printing', 'Label printing', 'optional', '1.0.0', '^1.0.0',
   'Print barcode labels from your own SKUs — for the half of the shelf no factory ever labelled.',
   '{}', '{}')
on conflict (plugin_key) do update
   set name = excluded.name,
       category = excluded.category,
       version = excluded.version,
       core_api_version = excluded.core_api_version,
       description = excluded.description,
       dependencies = excluded.dependencies,
       conflicts = excluded.conflicts;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. The balance is derived from the sales, not narrated by callers
-- ══════════════════════════════════════════════════════════════════════════

-- What one sale contributes to its customer's due. COMPLETED normally
-- contributes zero (it is fully paid by definition of `complete_sale`), but
-- the expression reads the columns rather than trusting the status, so a
-- future path that completes a sale oddly still books the right due.
-- REFUNDED and PARTIALLY_REFUNDED settle their money through
-- `sale_return_payments`; an unpaid remainder on a partially refunded sale
-- is still owed, so PARTIALLY_REFUNDED counts.
create or replace function app.sale_due(
  p_status public.sale_status,
  p_total  numeric,
  p_paid   numeric
)
returns numeric
language sql
immutable
as $fn$
  select case
    when p_status in ('COMPLETED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED')
      then greatest(p_total - p_paid, 0)
    else 0
  end
$fn$;

create or replace function app.maintain_customer_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old numeric(14,2) := 0;
  v_new numeric(14,2) := 0;
begin
  if tg_op = 'UPDATE' and old.customer_id is not null then
    v_old := app.sale_due(old.status, old.total, old.paid_total);
  end if;
  if new.customer_id is not null then
    v_new := app.sale_due(new.status, new.total, new.paid_total);
  end if;

  if tg_op = 'UPDATE' and old.customer_id is distinct from new.customer_id then
    -- The sale changed hands (a held sale resumed onto a customer, say):
    -- the old debtor is relieved and the new one charged, each exactly once.
    if old.customer_id is not null and v_old <> 0 then
      update public.customers set balance = balance - v_old where id = old.customer_id;
    end if;
    if new.customer_id is not null and v_new <> 0 then
      update public.customers set balance = balance + v_new where id = new.customer_id;
    end if;
  elsif new.customer_id is not null and v_new <> v_old then
    update public.customers set balance = balance + (v_new - v_old) where id = new.customer_id;
  end if;

  return new;
end
$fn$;

drop trigger if exists sales_maintain_customer_balance on public.sales;
create trigger sales_maintain_customer_balance
  after insert or update of status, total, paid_total, customer_id
  on public.sales
  for each row execute function app.maintain_customer_balance();

-- Backfill: any shop that already holds PARTIALLY_PAID sales gets the book
-- it should have had. Customers with no outstanding sales are reset to zero
-- rather than skipped — before this migration nothing wrote the column, so
-- whatever is there is not a fact.
update public.customers c
   set balance = coalesce(due.total_due, 0)
  from (
    select s.customer_id, sum(app.sale_due(s.status, s.total, s.paid_total)) as total_due
      from public.sales s
     where s.customer_id is not null
     group by s.customer_id
  ) due
 where due.customer_id = c.id
   and c.balance is distinct from coalesce(due.total_due, 0);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. A credit sale must name its debtor
-- ══════════════════════════════════════════════════════════════════════════

create or replace function app.require_credit_customer()
returns trigger
language plpgsql
as $fn$
begin
  if new.status = 'PARTIALLY_PAID' and new.customer_id is null then
    raise exception 'credit_sale_needs_customer'
      using errcode = '22023',
            hint = 'Attach a customer before taking partial payment — a due with no name can never be collected.';
  end if;
  return new;
end
$fn$;

drop trigger if exists sales_require_credit_customer on public.sales;
create trigger sales_require_credit_customer
  before insert or update of status, customer_id
  on public.sales
  for each row execute function app.require_credit_customer();

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Collecting: money in, oldest sale first
-- ══════════════════════════════════════════════════════════════════════════
--
-- The mirror of `apply_payment` (025), for the other side of the counter.
-- Two shapes, one function:
--
--   · With `p_sale_id` — pay down one named invoice, which is how a customer
--     settles the exact slip in their hand.
--   · Without — the khata shape: "here is 500 taka off what I owe". The
--     money walks the customer's open sales oldest first, paying each down
--     and marking the settled ones COMPLETED, so every taka collected is
--     attached to the invoice it paid and the payment-mix reports keep
--     working with no second bookkeeping.
--
-- Collecting *more* than is owed is refused, not banked: floating credit
-- already has a home (`store_credit`, written by `refund_sale_to_credit`),
-- and money accepted into the wrong column is the kind of mistake an audit
-- finds a year later. The customer's balance is not touched here at all —
-- the trigger above derives it from the very sale rows this function
-- updates, which is what makes it impossible for the two to disagree.

create or replace function public.collect_customer_payment(
  p_customer_id uuid,
  p_amount      numeric(14,2),
  p_method_id   uuid,
  p_sale_id     uuid default null,
  p_reference   text default null,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_customer  public.customers;
  v_sale      public.sales;
  v_remaining numeric(14,2);
  v_due       numeric(14,2);
  v_share     numeric(14,2);
  v_applied   jsonb := '[]'::jsonb;
  v_settled   integer := 0;
  v_balance   numeric(14,2);
begin
  select * into v_customer
    from public.customers
   where id = p_customer_id and deleted_at is null;
  if v_customer.id is null then
    raise exception 'customer_not_found: %', p_customer_id using errcode = 'P0002';
  end if;

  perform app.require_org(v_customer.organization_id);
  perform app.require_permission('sales.create');

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_must_be_positive' using errcode = '22023';
  end if;
  if not exists (select 1 from public.payment_methods
                  where id = p_method_id
                    and organization_id = v_customer.organization_id) then
    raise exception 'payment_method_not_found: %', p_method_id using errcode = 'P0002';
  end if;

  v_remaining := p_amount;

  -- Oldest first, rows locked: two cashiers collecting from the same
  -- customer at once must not pay the same invoice down twice.
  for v_sale in
    select * from public.sales
     where customer_id = p_customer_id
       and (p_sale_id is null or id = p_sale_id)
       and status = 'PARTIALLY_PAID'
       and total - paid_total > 0
     order by created_at
       for update
  loop
    exit when v_remaining <= 0;

    v_due   := v_sale.total - v_sale.paid_total;
    v_share := least(v_due, v_remaining);

    insert into public.sale_payments
          (sale_id, organization_id, method_id, amount, reference, received_by)
    values (v_sale.id, v_customer.organization_id, p_method_id, v_share,
            coalesce(p_reference, p_note), auth.uid());

    -- `paid_total` on the right-hand side is the pre-update value, so the
    -- settled test is written against what the row is about to become.
    update public.sales
       set paid_total = paid_total + v_share,
           status     = case when paid_total + v_share >= total
                             then 'COMPLETED'::public.sale_status
                             else status end
     where id = v_sale.id;

    if v_share >= v_due then
      v_settled := v_settled + 1;
    end if;
    v_applied := v_applied || jsonb_build_object(
      'sale_id', v_sale.id, 'invoice_no', v_sale.invoice_no, 'amount', v_share
    );
    v_remaining := v_remaining - v_share;
  end loop;

  if v_remaining > 0 then
    raise exception 'over_payment: outstanding %', p_amount - v_remaining
      using errcode = '22023',
            hint = 'Collect at most what is owed. Money returned for goods goes through refunds; money held for later belongs in store credit.';
  end if;

  select balance into v_balance from public.customers where id = p_customer_id;

  insert into public.outbox
        (organization_id, event_type, aggregate_type, aggregate_id, payload)
  values (v_customer.organization_id, 'customer.payment', 'customer', p_customer_id,
          jsonb_build_object('amount', p_amount, 'method_id', p_method_id,
                             'reference', coalesce(p_reference, p_note),
                             'applied', v_applied));

  return jsonb_build_object(
    'collected',        p_amount,
    'customer_balance', v_balance,
    'sales_settled',    v_settled,
    'applied',          v_applied
  );
end
$fn$;

-- The grants discipline of 018: nothing this migration created is callable
-- by an anonymous visitor, and only the RPC is callable by a signed-in one —
-- the trigger functions and the due expression are the database's own.
revoke execute on function app.sale_due(public.sale_status, numeric, numeric) from public, anon, authenticated;
revoke execute on function app.maintain_customer_balance() from public, anon, authenticated;
revoke execute on function app.require_credit_customer() from public, anon, authenticated;
revoke execute on function public.collect_customer_payment(uuid, numeric, uuid, uuid, text, text) from public, anon;
grant execute on function public.collect_customer_payment(uuid, numeric, uuid, uuid, text, text) to authenticated;
