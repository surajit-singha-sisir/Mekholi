-- 059 — The due book, packaged (the plugin face of 057).
--
-- 057 built the ledger itself: balances derived from sales, credit sales
-- that must name their debtor, collection oldest-first. Those stay core —
-- money integrity is not optional equipment. What 057 did not build is the
-- *book*: the one screen a shopkeeper actually keeps open, "who owes me,
-- how much, since when". That is presentation, presentation is a choice,
-- and choices are plugins.
--
-- The due-ledger plugin owns that book: a debtors screen, a dashboard
-- tile, and — through the client gating on the plugin being loaded — the
-- "keep as due" button on the till and "collect due" on the customer card.
-- A shop that never sells on credit disables one plugin and every due
-- surface disappears together; the trigger keeps guarding the data
-- underneath either way, because a disabled screen must never mean an
-- untended ledger.
--
-- The functions travel the packaged way (031): the exact bytes of
-- supabase/plugins/due-ledger/001_functions.sql, embedded, executed, and
-- recorded in plugin_package_migrations with their checksum — one source,
-- three witnesses. Each function re-checks org and permission itself,
-- because `security definer` means the RPC bridge's checks are the only
-- other thing standing in front of them. Gated on `customers.view` —
-- whoever may see the customers may see what they owe (056 philosophy:
-- no invented keys).

-- ── The package ───────────────────────────────────────────────────────────
insert into public.plugin_packages
      (plugin_key, name, category, version, core_api_version, description,
       dependencies, conflicts)
values
  ('due-ledger', 'Due book (বাকির খাতা)', 'optional', '1.0.0', '^1.0.0',
   'Sell on credit and keep the khata: who owes what, since when, and the collection buttons on the till and the customer card.',
   '{}', '{}')
on conflict (plugin_key) do update
   set name = excluded.name,
       category = excluded.category,
       version = excluded.version,
       core_api_version = excluded.core_api_version,
       description = excluded.description,
       dependencies = excluded.dependencies,
       conflicts = excluded.conflicts;

-- ── The functions, packaged and applied ───────────────────────────────────
do $do$
declare
  v_sql text;
begin
  -- ── 001_functions.sql ─────────────────────────────────────────────────
  v_sql := $plg_1$-- ── The book ──────────────────────────────────────────────────────────────
-- Everyone who owes, biggest debt first. Minor units, like every jsonb the
-- client reads (round half away, matching the money domain).
create or replace function public.due_ledger_book(
  p_organization_id uuid,
  p_args jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_search text := nullif(trim(coalesce(p_args ->> 'search', '')), '');
  v_limit  integer := least(greatest(coalesce(nullif(p_args ->> 'limit', '')::integer, 100), 1), 500);
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('customers.view');

  return jsonb_build_object(
    'total_due_minor', coalesce((
      select round(sum(c.balance) * 100)::bigint
        from public.customers c
       where c.organization_id = p_organization_id
         and c.deleted_at is null
         and c.balance > 0
    ), 0),
    'debtor_count', coalesce((
      select count(*)
        from public.customers c
       where c.organization_id = p_organization_id
         and c.deleted_at is null
         and c.balance > 0
    ), 0),
    'debtors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id,
               'name', d.name,
               'phone', d.phone,
               'balance_minor', round(d.balance * 100)::bigint,
               'credit_limit_minor', round(d.credit_limit * 100)::bigint,
               'open_sales', d.open_sales,
               'oldest_due_at', d.oldest_due_at
             ) order by d.balance desc, d.name)
        from (
          select c.id, c.name, c.phone, c.balance, c.credit_limit,
                 -- The open invoices behind the figure, and how long the
                 -- oldest has waited — "since when" is half the khata.
                 (select count(*) from public.sales s
                   where s.customer_id = c.id and s.status = 'PARTIALLY_PAID') as open_sales,
                 (select min(s.created_at) from public.sales s
                   where s.customer_id = c.id and s.status = 'PARTIALLY_PAID') as oldest_due_at
            from public.customers c
           where c.organization_id = p_organization_id
             and c.deleted_at is null
             and c.balance > 0
             and (v_search is null
                  or c.name ilike '%' || v_search || '%'
                  or c.phone ilike '%' || v_search || '%')
           order by c.balance desc, c.name
           limit v_limit
        ) d
    ), '[]'::jsonb)
  );
end
$fn$;

-- ── The tile ──────────────────────────────────────────────────────────────
-- The two numbers the dashboard wants, without shipping the whole book.
create or replace function public.due_ledger_summary(
  p_organization_id uuid,
  p_args jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('customers.view');

  return coalesce((
    select jsonb_build_object(
             'total_due_minor', coalesce(round(sum(c.balance) * 100), 0)::bigint,
             'debtor_count', count(*)
           )
      from public.customers c
     where c.organization_id = p_organization_id
       and c.deleted_at is null
       and c.balance > 0
  ), jsonb_build_object('total_due_minor', 0, 'debtor_count', 0));
end
$fn$;

-- The grants discipline of 018: callable by a signed-in user (the bridge
-- and the functions both re-check org and permission), never by anon.
revoke execute on function public.due_ledger_book(uuid, jsonb) from public, anon;
revoke execute on function public.due_ledger_summary(uuid, jsonb) from public, anon;
grant execute on function public.due_ledger_book(uuid, jsonb) to authenticated;
grant execute on function public.due_ledger_summary(uuid, jsonb) to authenticated;
$plg_1$;

  -- Applied here so every database that runs the migrations has the
  -- functions (the read surface is harmless without the plugin: the RPC
  -- bridge refuses `due_ledger_*` until the shop enables it), and recorded
  -- as the package's own migration so the enable flow sees the same bytes.
  execute v_sql;

  insert into public.plugin_package_migrations
        (plugin_key, filename, version, ordinal, checksum, sql)
  values ('due-ledger', '001_functions.sql', '1.0.0', 1, md5(v_sql), v_sql)
  on conflict (plugin_key, filename) do update
     set version = excluded.version,
         ordinal = excluded.ordinal,
         checksum = excluded.checksum,
         sql = excluded.sql;
end
$do$;
