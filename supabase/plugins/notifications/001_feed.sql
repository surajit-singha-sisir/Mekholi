-- notifications 001 — the feed.
--
-- One function, one round trip, everything the bell needs. The client asks
-- only for the sections the shop has switched on (the toggles live in the
-- plugin's config), and a section not asked for costs no query at all.
--
-- Everything here is *derived* — counted and summed from the shop's own
-- tables at the moment of asking. Nothing is stored, queued or marked:
-- a notification that has to be true is one that is recomputed, and what
-- "read" means is a per-device affair the client keeps for itself.
--
-- Gated on `dashboard.view` (056 philosophy: no invented keys): the bell
-- summarises the same numbers the dashboard shows, so whoever may read
-- the one may read the other.

create or replace function public.notifications_feed(
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
  v_want_stock   boolean := coalesce((p_args ->> 'stock')::boolean, true);
  v_want_dues    boolean := coalesce((p_args ->> 'dues')::boolean, true);
  v_want_summary boolean := coalesce((p_args ->> 'summary')::boolean, true);
  -- Dues smaller than this stay out of the bell — ৳20 of baki is a
  -- neighbourly arrangement, not an alert.
  v_due_floor    numeric := coalesce((p_args ->> 'due_floor_minor')::numeric, 0) / 100;
  v_stock        jsonb := null;
  v_dues         jsonb := null;
  v_summary      jsonb := null;
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('dashboard.view');

  if v_want_stock then
    -- One pass over the balances: a tracked product with nothing anywhere
    -- is out, one at or under its own reorder point is low. Products that
    -- never asked to be counted (track_stock off) stay silent. Names are
    -- capped at five per shelf — the bell says enough to act on, the
    -- stock screen says the rest.
    with scope as (
      select p.name,
             p.reorder_point,
             coalesce(sum(sb.quantity), 0) as on_hand
        from public.products p
        left join public.stock_balances sb
               on sb.product_id = p.id
              and sb.organization_id = p.organization_id
       where p.organization_id = p_organization_id
         and p.deleted_at is null
         and p.is_active
         and p.track_stock
       group by p.id, p.name, p.reorder_point
      having coalesce(sum(sb.quantity), 0) <= p.reorder_point
    )
    select jsonb_build_object(
             'out_count', (select count(*) from scope where on_hand <= 0),
             'out_names', coalesce((
               select jsonb_agg(x.name order by x.name)
                 from (select name from scope where on_hand <= 0 order by name limit 5) x), '[]'::jsonb),
             'low_count', (select count(*) from scope where on_hand > 0),
             'low_names', coalesce((
               select jsonb_agg(y.name order by y.name)
                 from (select name from scope where on_hand > 0 order by on_hand, name limit 5) y), '[]'::jsonb)
           )
      into v_stock;
  end if;

  if v_want_dues then
    select jsonb_build_object(
             'debtor_count', count(*),
             'total_due_minor', coalesce(round(sum(c.balance) * 100), 0)::bigint,
             'top_name', (select d.name from public.customers d
                           where d.organization_id = p_organization_id
                             and d.deleted_at is null and d.balance >= greatest(v_due_floor, 0.01)
                           order by d.balance desc, d.name limit 1),
             'top_due_minor', coalesce((select round(d.balance * 100) from public.customers d
                           where d.organization_id = p_organization_id
                             and d.deleted_at is null and d.balance >= greatest(v_due_floor, 0.01)
                           order by d.balance desc, d.name limit 1), 0)::bigint
           )
      into v_dues
      from public.customers c
     where c.organization_id = p_organization_id
       and c.deleted_at is null
       and c.balance >= greatest(v_due_floor, 0.01);
  end if;

  if v_want_summary then
    -- The trading day so far: sales that actually happened. Refund states
    -- are excluded from the count but their totals already reflect what
    -- came back, so the figure is the shop's honest gross for today.
    select jsonb_build_object(
             'sale_count', count(*),
             'total_minor', coalesce(round(sum(s.total) * 100), 0)::bigint
           )
      into v_summary
      from public.sales s
     where s.organization_id = p_organization_id
       and s.status in ('COMPLETED', 'PARTIALLY_PAID')
       and s.created_at >= date_trunc('day', now());
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'stock', v_stock,
    'dues', v_dues,
    'summary', v_summary
  );
end
$fn$;

-- The grants discipline of 018: callable by a signed-in user (the bridge
-- and the function both re-check org and permission), never by anon.
revoke execute on function public.notifications_feed(uuid, jsonb) from public, anon;
grant execute on function public.notifications_feed(uuid, jsonb) to authenticated;
