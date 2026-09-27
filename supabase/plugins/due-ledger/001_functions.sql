-- ── The book ──────────────────────────────────────────────────────────────
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
