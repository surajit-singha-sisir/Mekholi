-- 003 — Line-level opt-out: the cashier's "not this one" at the till.
--
-- A sale promises cover on every line that carries it, and until now the till
-- had no way to say "everything here is covered *except* this one" — the fridge
-- is guaranteed, the extension lead the customer threw in is not. This file
-- adds that single decision, and nothing more.
--
-- Three things make it safe rather than clever:
--
--   · **The decision is a fact about the sale, not about the device.** A shop
--     with two tills, a phone that took the sale offline and a Realtime row
--     that lands on a third screen all register the *same* promises, because
--     the opt-out is written to a table keyed by the sale — not held in the
--     memory of whichever till happened to ring it up. Any device that later
--     registers the sale reads the same list and skips the same lines.
--
--   · **Opting out is not the same as covering nothing.** A line the cashier
--     un-ticks is recorded here and skipped by the register; a line nobody
--     touched is covered exactly as before. Removing the row (a correction, a
--     change of mind before the promise is written) puts the line back in.
--
--   · **It writes only this plugin's own table.** The register already skips a
--     line whose product promises nothing; this teaches it to skip a line the
--     shop chose not to promise, from a list it owns, and the ledger stays the
--     core's (spec §51).

-- ── The opt-out list ───────────────────────────────────────────────────────
-- One row per line the shop chose not to cover, per sale. `variant_id` rather
-- than the sale-item id, because that is what the till knows while the cart is
-- still open and the sale does not exist yet — and a cart holds a variant once,
-- so it is enough to name the line.
create table if not exists public.plg_warranty_line_optouts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sale_id         uuid not null references public.sales(id) on delete cascade,
  variant_id      uuid not null references public.product_variants(id) on delete cascade,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  -- The same line un-ticked twice — a retry, a Realtime redelivery, both tills
  -- agreeing — is one opt-out, not two. This is what makes writing it as
  -- idempotent as registering the promise it prevents.
  constraint plg_warranty_optout_unit unique (organization_id, sale_id, variant_id)
);

create index if not exists plg_warranty_optout_sale_idx
  on public.plg_warranty_line_optouts (organization_id, sale_id);

alter table public.plg_warranty_line_optouts enable row level security;

-- Reading needs `warranty.view`, writing needs `warranty.manage` — the same two
-- keys the promises themselves are behind, so a counter that can look cover up
-- can see what was left uncovered, and only a manager can change it.
drop policy if exists plg_warranty_optout_select on public.plg_warranty_line_optouts;
create policy plg_warranty_optout_select on public.plg_warranty_line_optouts
  for select using (
    app.in_org(organization_id) and app.has_permission('warranty.view')
  );

drop policy if exists plg_warranty_optout_write on public.plg_warranty_line_optouts;
create policy plg_warranty_optout_write on public.plg_warranty_line_optouts
  for all using (
    app.in_org(organization_id) and app.has_permission('warranty.manage')
  )
  with check (
    app.in_org(organization_id) and app.has_permission('warranty.manage')
  );

grant select, insert, update, delete on public.plg_warranty_line_optouts to authenticated;

-- ── Registering, now with the opt-out honoured ──────────────────────────────
-- Byte-for-byte the register from 002, with one addition: it loads the sale's
-- opt-out list up front and skips any line on it, counting it among the lines
-- it skipped for any other reason. Redefined in full (not patched) because a
-- `create or replace` is the whole body or none of it, and the whole body is
-- what a reader needs to trust the skip is the *only* change.
create or replace function app.warranty_register_sale(
  p_org uuid,
  p_sale_id uuid,
  p_months integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_config  jsonb;
  v_cover   boolean;
  v_default integer;
  v_terms   text;
  v_sale    record;
  v_customer uuid;
  v_today   date;
  v_line    record;
  v_months  integer;
  v_units   integer;
  v_taken   integer;
  v_made    integer := 0;
  v_have    integer := 0;
  v_capped  integer := 0;
  v_skipped integer := 0;
  v_index   integer;
  v_label   text;
  v_optouts uuid[];
  v_units_json jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.plugins pl
     where pl.organization_id = p_org and pl.plugin_key = 'warranty' and pl.enabled
  ) then
    raise exception 'plugin_not_enabled: %', 'warranty' using errcode = 'P0001';
  end if;

  select sa.id, sa.invoice_no, sa.branch_id, sa.status, sa.customer_id
    into v_sale
    from public.sales sa
   where sa.id = p_sale_id and sa.organization_id = p_org;

  if not found then
    raise exception 'warranty_unknown_sale: %', p_sale_id using errcode = 'P0002';
  end if;

  -- A draft or a held sale has not sold anything yet, and a cancelled one sold
  -- nothing at all: promising cover on either would be standing behind a sale
  -- that never happened.
  if v_sale.status not in ('COMPLETED', 'PARTIALLY_PAID', 'REFUNDED', 'PARTIALLY_REFUNDED') then
    raise exception 'warranty_sale_not_sold: % (%)', p_sale_id, v_sale.status using errcode = 'P0001';
  end if;

  v_customer := v_sale.customer_id;
  v_config  := app.warranty_config(p_org);
  v_cover   := (v_config ->> 'cover_all_lines')::boolean;
  v_default := (v_config ->> 'default_months')::int;
  -- The promise starts on the day the shop sold it, in the shop's own timezone
  -- — not on the day a client happened to register it.
  v_today   := app.warranty_today(p_org, v_sale.branch_id);
  v_terms   := 'Covered by ' || coalesce(
                 (select o.name from public.organizations o where o.id = p_org), 'the shop');

  -- The lines the shop chose not to cover on this sale. Read once, so a line on
  -- the list is skipped no matter which device is doing the registering.
  select coalesce(array_agg(o.variant_id), '{}')
    into v_optouts
    from public.plg_warranty_line_optouts o
   where o.organization_id = p_org and o.sale_id = p_sale_id;

  for v_line in
    select si.id, si.product_id, si.variant_id, si.product_name, si.variant_name,
           coalesce(si.unit_label, '') as unit_label,
           greatest(0, ceil(si.quantity - coalesce(si.returned_qty, 0)))::int as sold_units
      from public.sale_items si
     where si.sale_id = p_sale_id and si.organization_id = p_org
     order by si.product_name, si.id
  loop
    if v_line.sold_units <= 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- The cashier un-ticked this line: it is a promise the shop chose not to
    -- make, counted among the skipped rather than written.
    if v_line.variant_id = any(v_optouts) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_months := coalesce(
      case when p_months is not null and p_months > 0 then p_months end,
      app.warranty_months_for(p_org, v_line.product_id),
      case when v_cover then v_default end
    );

    if v_months is null or v_months <= 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_months := least(600, v_months);

    -- A line of 500 identical bolts is not 500 promises: nobody will ever look
    -- one of them up. The cap is loud in the result (`capped_lines`) rather
    -- than silent, and a shop that means it promises per unit by selling them
    -- separately.
    v_units := least(50, v_line.sold_units);
    if v_line.sold_units > v_units then
      v_capped := v_capped + 1;
    end if;

    select count(*)::int into v_taken
      from public.plg_warranty_warranties w
     where w.organization_id = p_org
       and w.sale_item_id = v_line.id
       and w.status = 'ACTIVE';

    v_have := v_have + least(v_taken, v_units);

    for v_index in (v_taken + 1)..v_units loop
      -- A single unit can carry the line's own label. Several cannot share it,
      -- so they are numbered and the shop labels them from the register.
      v_label := nullif(btrim(v_line.unit_label), '');
      if v_label is not null and v_units > 1 then
        v_label := null;
      end if;

      insert into public.plg_warranty_warranties
            (organization_id, sale_id, sale_item_id, product_id, variant_id,
             customer_id, product_name, variant_name, unit_label, unit_index,
             months, provider, terms, starts_on, ends_on, created_by)
      values (p_org, p_sale_id, v_line.id, v_line.product_id, v_line.variant_id,
              v_customer, v_line.product_name, v_line.variant_name,
              v_label, v_index, v_months, 'SHOP', v_terms, v_today,
              app.warranty_end(v_today, v_months), auth.uid())
      on conflict do nothing;

      -- `on conflict do nothing` leaves FOUND false when the promise is already
      -- there, which is exactly the count this returns.
      if found then
        v_made := v_made + 1;
      end if;
    end loop;
  end loop;

  select coalesce(jsonb_agg(u order by (u ->> 'ends_on'), (u ->> 'unit_index')::int), '[]'::jsonb)
    into v_units_json
    from jsonb_array_elements(
           app.warranty_page(p_org, jsonb_build_object('sale_id', p_sale_id, 'limit', 500)) -> 'rows'
         ) u;

  return jsonb_build_object(
    'sale_id',       p_sale_id,
    'invoice_no',    v_sale.invoice_no,
    'created',       v_made,
    'existing',      v_have,
    'skipped_lines', v_skipped,
    'capped_lines',  v_capped,
    'starts_on',     v_today,
    'units',         v_units_json
  );
end
$fn$;

-- ── The client's way in, now carrying the opt-out ───────────────────────────
-- The till hands `skip_variants` — the lines the cashier un-ticked — alongside
-- the sale. They are written to the opt-out list *before* the register runs, so
-- the register (this call's and every other device's) reads them back and skips
-- them. A call with no `skip_variants` changes nothing, which is exactly what a
-- second device redelivering the same sale should do.
create or replace function public.warranty_register(p_organization_id uuid, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org    uuid := p_organization_id;
  v_sale   uuid := nullif(p_args ->> 'sale_id', '')::uuid;
  v_months integer := case when coalesce(p_args ->> 'months', '') ~ '^[0-9]{1,3}$'
                             then (p_args ->> 'months')::int end;
  v_skip   uuid[];
begin
  perform app.require_org(v_org);
  perform app.require_permission('warranty.manage');

  if v_sale is null then
    raise exception 'warranty_sale_required' using errcode = '22023';
  end if;

  -- The un-ticked lines, as ids. Anything that is not a uuid is dropped rather
  -- than trusted: the till names variants, and a caller that names something
  -- else is not naming a line of this sale.
  if jsonb_typeof(p_args -> 'skip_variants') = 'array' then
    select coalesce(array_agg(val::uuid), '{}')
      into v_skip
      from jsonb_array_elements_text(p_args -> 'skip_variants') as t(val)
     where val ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  else
    v_skip := '{}';
  end if;

  if array_length(v_skip, 1) is not null then
    insert into public.plg_warranty_line_optouts (organization_id, sale_id, variant_id, created_by)
    select v_org, v_sale, s, auth.uid()
      from unnest(v_skip) as s
     where exists (
       select 1 from public.sale_items si
        where si.sale_id = v_sale and si.organization_id = v_org and si.variant_id = s
     )
    on conflict (organization_id, sale_id, variant_id) do nothing;
  end if;

  return app.warranty_register_sale(v_org, v_sale, v_months)
    || jsonb_build_object('lines', app.warranty_sale_lines(v_org, v_sale));
end
$fn$;
