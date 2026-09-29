-- 072 — Notifications feed v2: warranty expiry and stock transfers.
--
-- 063 shipped the bell's first feed (supabase/plugins/notifications/001_feed.sql)
-- watching stock, dues and the day's takings. This carries the plugin's second
-- packaged migration — supabase/plugins/notifications/002_feed.sql — the exact
-- bytes, embedded, executed, and recorded in plugin_package_migrations as
-- ordinal 2. It adds two watchers to the same discipline (everything derived,
-- nothing stored): warranty promises about to lapse (read through guarded
-- dynamic SQL, so the warranty plugin need not be installed) and stock
-- transfers that moved between locations in the last day.
--
-- The function is `create or replace`, so applied in order the final shape is
-- 002's superset. One source, three witnesses — the file, the embedded copy
-- here, and the checksum in plugin_package_migrations.

-- ── The packaged migration ────────────────────────────────────────────────
do $do$
declare
  v_sql text;
begin
  v_sql := $plg_2$-- notifications 002 — warranty expiry and stock transfers join the feed.
--
-- The bell already watches stock (out and at-reorder-point), dues and the
-- day's takings. This adds two more watchers, kept to the same discipline:
-- everything is *derived* at the moment of asking, nothing is stored or
-- queued, and a section the shop switched off costs no query.
--
--   · **Warranty expiry** — promises about to lapse, and ones that already
--     have. Read from the warranty plugin's own table *through dynamic SQL*
--     and guarded by `to_regclass`, so this function installs and runs whether
--     or not that plugin is present. Dates are read as plain days in the shop's
--     timezone, never as timestamps, so a promise cannot lapse a day early.
--
--   · **Stock transfers** — what moved between locations in the last day, so a
--     branch hears what arrived and what left. `stock_transfers` is a core
--     table, always there, so this half is static.
--
-- Gated on `dashboard.view`, exactly as 001: the bell summarises numbers the
-- dashboard may already show.

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
  v_want_stock     boolean := coalesce((p_args ->> 'stock')::boolean, true);
  v_want_dues      boolean := coalesce((p_args ->> 'dues')::boolean, true);
  v_want_summary   boolean := coalesce((p_args ->> 'summary')::boolean, true);
  v_want_warranty  boolean := coalesce((p_args ->> 'warranty')::boolean, true);
  v_want_transfers boolean := coalesce((p_args ->> 'transfers')::boolean, true);
  -- Dues smaller than this stay out of the bell — ৳20 of baki is a
  -- neighbourly arrangement, not an alert.
  v_due_floor      numeric := coalesce((p_args ->> 'due_floor_minor')::numeric, 0) / 100;
  v_horizon_days   integer := 30;
  v_window_hours   integer := 24;
  v_tz             text;
  v_today          date;
  v_horizon_to     date;
  v_stock          jsonb := null;
  v_dues           jsonb := null;
  v_summary        jsonb := null;
  v_warranty       jsonb := null;
  v_transfers      jsonb := null;
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('dashboard.view');

  select timezone into v_tz from public.organizations where id = p_organization_id;
  v_today      := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  v_horizon_to := v_today + v_horizon_days;

  if v_want_stock then
    -- One pass over the balances: a tracked product with nothing anywhere
    -- is out, one at or under its own reorder point is low.
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

  -- Warranty: read through dynamic SQL and guarded, so the feed does not
  -- depend on the warranty plugin being installed. Only ACTIVE promises count —
  -- a voided one is not a promise. "Expiring" is inside the horizon; "expired"
  -- is a day already past, still ACTIVE and so still liable to a claim.
  if v_want_warranty and to_regclass('public.plg_warranty_warranties') is not null then
    execute format($q$
      select jsonb_build_object(
        'expiring_count', count(*) filter (where ends_on >= %1$L and ends_on <= %2$L),
        'expired_count',  count(*) filter (where ends_on < %1$L),
        'horizon_days',   %3$s,
        'soonest_name', (select w.product_name from public.plg_warranty_warranties w
                          where w.organization_id = %4$L and w.status = 'ACTIVE'
                            and w.ends_on >= %1$L and w.ends_on <= %2$L
                          order by w.ends_on, w.product_name limit 1),
        'soonest_ends_on', (select w.ends_on from public.plg_warranty_warranties w
                          where w.organization_id = %4$L and w.status = 'ACTIVE'
                            and w.ends_on >= %1$L and w.ends_on <= %2$L
                          order by w.ends_on, w.product_name limit 1),
        'expiring_names', coalesce((
            select jsonb_agg(x.product_name order by x.ends_on, x.product_name)
              from (select product_name, ends_on
                      from public.plg_warranty_warranties
                     where organization_id = %4$L and status = 'ACTIVE'
                       and ends_on >= %1$L and ends_on <= %2$L
                     order by ends_on, product_name limit 5) x), '[]'::jsonb)
      )
      from public.plg_warranty_warranties
      where organization_id = %4$L and status = 'ACTIVE'
    $q$, v_today, v_horizon_to, v_horizon_days, p_organization_id)
    into v_warranty;

    -- Nothing active, nothing to say.
    if coalesce((v_warranty ->> 'expiring_count')::int, 0) = 0
       and coalesce((v_warranty ->> 'expired_count')::int, 0) = 0 then
      v_warranty := null;
    end if;
  end if;

  -- Transfers: what moved between locations in the last day. A branch reads the
  -- endpoints by name, so "notify the branch" is a sentence, not an id.
  if v_want_transfers then
    with recent as (
      select t.id, t.created_at, wf.name as from_name, wt.name as to_name
        from public.stock_transfers t
        join public.warehouses wf on wf.id = t.from_warehouse_id
        join public.warehouses wt on wt.id = t.to_warehouse_id
       where t.organization_id = p_organization_id
         and t.created_at >= now() - make_interval(hours => v_window_hours)
    ),
    latest as (
      select * from recent order by created_at desc limit 1
    )
    select jsonb_build_object(
             'count', (select count(*) from recent),
             'unit_count', coalesce((
                 select round(sum(i.quantity), 3)
                   from public.stock_transfer_items i
                   join recent r on r.id = i.transfer_id), 0),
             'latest_from', (select from_name from latest),
             'latest_to',   (select to_name from latest),
             'latest_names', coalesce((
                 select jsonb_agg(x.name order by x.name)
                   from (select p.name
                           from public.stock_transfer_items i
                           join latest l on l.id = i.transfer_id
                           join public.products p on p.id = i.product_id
                          order by p.name limit 5) x), '[]'::jsonb),
             'window_hours', v_window_hours
           )
      into v_transfers;

    if coalesce((v_transfers ->> 'count')::int, 0) = 0 then
      v_transfers := null;
    end if;
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'stock', v_stock,
    'dues', v_dues,
    'summary', v_summary,
    'warranty', v_warranty,
    'transfers', v_transfers
  );
end
$fn$;

revoke execute on function public.notifications_feed(uuid, jsonb) from public, anon;
grant execute on function public.notifications_feed(uuid, jsonb) to authenticated;
$plg_2$;

  -- Applied here so every database that runs the migrations has the newer
  -- function (harmless without the plugin: the RPC bridge refuses
  -- `notifications_*` until the shop enables it), and recorded as the
  -- package's own migration so the enable flow sees the same bytes.
  execute v_sql;

  insert into public.plugin_package_migrations
        (plugin_key, filename, version, ordinal, checksum, sql)
  values ('notifications', '002_feed.sql', '1.0.0', 2, md5(v_sql), v_sql)
  on conflict (plugin_key, filename) do update
     set version = excluded.version,
         ordinal = excluded.ordinal,
         checksum = excluded.checksum,
         sql = excluded.sql;
end
$do$;
