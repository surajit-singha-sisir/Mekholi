-- 066 — Developer control plane: server-owned platform access and read-only operations.
-- Cross-tenant data is never exposed through ordinary tenant RLS. Every public
-- function below checks a platform permission under SECURITY DEFINER.

create table public.platform_roles (
  key text primary key,
  name text not null,
  permissions text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.platform_user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role_key text not null references public.platform_roles(key) on delete cascade,
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role_key)
);

create table public.platform_log_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  environment text not null default 'production',
  severity text not null check (severity in ('debug','info','warning','error','critical')),
  source text not null,
  organization_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  plugin_key text,
  action text not null,
  message text not null,
  correlation_id text,
  duration_ms integer,
  outcome text,
  error_code text,
  metadata jsonb not null default '{}',
  check (pg_column_size(metadata) <= 65536)
);

create index platform_log_events_time_idx on public.platform_log_events (occurred_at desc);
create index platform_log_events_org_time_idx on public.platform_log_events (organization_id, occurred_at desc);
create index platform_log_events_plugin_time_idx on public.platform_log_events (plugin_key, occurred_at desc);

create table public.platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  organization_id uuid references public.organizations(id) on delete set null,
  reason text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

alter table public.platform_roles enable row level security;
alter table public.platform_roles force row level security;
alter table public.platform_user_roles enable row level security;
alter table public.platform_user_roles force row level security;
alter table public.platform_log_events enable row level security;
alter table public.platform_log_events force row level security;
alter table public.platform_audit_log enable row level security;
alter table public.platform_audit_log force row level security;

revoke all on public.platform_roles, public.platform_user_roles,
  public.platform_log_events, public.platform_audit_log from anon, authenticated;

insert into public.platform_roles (key, name, permissions) values
  ('platform_owner', 'Platform owner', array['*']),
  ('plugin_developer', 'Plugin developer', array['developer.dashboard.view','platform.shops.view','platform.plugins.view','platform.plugins.create','platform.plugins.edit','platform.logs.view']),
  ('support_operator', 'Support operator', array['developer.dashboard.view','platform.shops.view','platform.plugins.view','platform.logs.view']),
  ('auditor', 'Auditor', array['developer.dashboard.view','platform.shops.view','platform.plugins.view','platform.logs.view','platform.audit.view'])
on conflict (key) do update set name = excluded.name, permissions = excluded.permissions;

create or replace function app.has_platform_permission(p_key text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.platform_user_roles ur
    join public.platform_roles r on r.key = ur.role_key
    where ur.user_id = auth.uid()
      and ('*' = any(r.permissions) or p_key = any(r.permissions)
           or split_part(p_key, '.', 1) || '.*' = any(r.permissions))
  )
$fn$;

create or replace function app.require_platform_permission(p_key text)
returns void language plpgsql stable security definer set search_path = public as $fn$
begin
  if auth.uid() is null or not app.has_platform_permission(p_key) then
    raise exception 'platform_permission_denied: %', p_key using errcode = '42501';
  end if;
end
$fn$;

revoke all on function app.has_platform_permission(text), app.require_platform_permission(text) from public, anon, authenticated;

create or replace function public.developer_session()
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare
  v_roles text[];
  v_permissions text[];
begin
  select coalesce(array_agg(distinct r.key), '{}'),
         coalesce(array_agg(distinct p) filter (where p is not null), '{}')
    into v_roles, v_permissions
    from public.platform_user_roles ur
    join public.platform_roles r on r.key = ur.role_key
    left join lateral unnest(r.permissions) p on true
   where ur.user_id = auth.uid();
  return jsonb_build_object('enabled', cardinality(v_roles) > 0,
    'roles', to_jsonb(v_roles), 'permissions', to_jsonb(v_permissions));
end
$fn$;

create or replace function public.developer_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
begin
  perform app.require_platform_permission('developer.dashboard.view');
  return jsonb_build_object(
    'shops', (select count(*) from public.organizations),
    'shops_today', (select count(*) from public.organizations where created_at >= current_date),
    'users', (select count(*) from auth.users),
    'packages', (select count(*) from public.plugin_packages),
    'enabled_plugins', (select count(*) from public.plugins where enabled),
    'plugin_errors', (select count(*) from public.plugins where status = 'error'),
    'error_logs_24h', (select count(*) from public.platform_log_events where severity in ('error','critical') and occurred_at >= now() - interval '24 hours'),
    'generated_at', now());
end
$fn$;

create or replace function public.developer_shops(p_search text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
begin
  perform app.require_platform_permission('platform.shops.view');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
    select o.id, o.name, o.slug, o.shop_type, o.currency, o.timezone, o.created_at,
      (select count(*) from public.user_organizations uo where uo.organization_id=o.id and uo.is_active) as staff_count,
      (select count(*) from public.branches b where b.organization_id=o.id and b.deleted_at is null) as branch_count,
      (select count(*) from public.plugins p where p.organization_id=o.id and p.enabled) as plugin_count,
      exists(select 1 from public.plugins p where p.organization_id=o.id and p.status='error') as has_plugin_error
    from public.organizations o
    where nullif(trim(coalesce(p_search,'')), '') is null
       or lower(o.name || ' ' || o.slug || ' ' || o.id::text) like '%' || lower(trim(p_search)) || '%'
    order by o.created_at desc limit least(greatest(coalesce(p_limit,100),1),500)
  ) x), '[]'::jsonb);
end
$fn$;

create or replace function public.developer_shop(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare
  v_out jsonb;
begin
  perform app.require_platform_permission('platform.shops.view');
  select to_jsonb(x) into v_out from (
    select o.id, o.name, o.slug, o.shop_type, o.currency, o.timezone, o.locale,
      o.logo_url, o.created_at, o.updated_at,
      (select count(*) from public.user_organizations uo where uo.organization_id=o.id and uo.is_active) staff_count,
      (select count(*) from public.branches b where b.organization_id=o.id and b.deleted_at is null) branch_count,
      (select count(*) from public.warehouses w where w.organization_id=o.id and w.deleted_at is null) warehouse_count,
      (select count(*) from public.registers r where r.organization_id=o.id and r.deleted_at is null) register_count,
      coalesce((select jsonb_agg(jsonb_build_object('key',p.plugin_key,'version',p.version,'enabled',p.enabled,'status',p.status,'last_error',p.last_error,'enabled_at',p.enabled_at) order by p.plugin_key) from public.plugins p where p.organization_id=o.id),'[]'::jsonb) plugins
    from public.organizations o where o.id=p_organization_id
  ) x;
  if v_out is null then raise exception 'shop_not_found' using errcode='P0002'; end if;
  return v_out;
end
$fn$;

create or replace function public.developer_plugins()
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
begin
  perform app.require_platform_permission('platform.plugins.view');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
    select pk.plugin_key as key, pk.name, pk.category, pk.version, pk.core_api_version,
      pk.description, pk.dependencies, pk.conflicts,
      (select count(*) from public.plugins p where p.plugin_key=pk.plugin_key) installed_shops,
      (select count(*) from public.plugins p where p.plugin_key=pk.plugin_key and p.enabled) enabled_shops,
      (select count(*) from public.plugins p where p.plugin_key=pk.plugin_key and p.status='error') error_shops,
      (select count(*) from public.plugin_package_permissions pp where pp.plugin_key=pk.plugin_key) permission_count,
      (select count(*) from public.plugin_package_migrations pm where pm.plugin_key=pk.plugin_key) migration_count
    from public.plugin_packages pk
  ) x), '[]'::jsonb);
end
$fn$;

create or replace function public.developer_logs(p_organization_id uuid default null, p_plugin_key text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
begin
  perform app.require_platform_permission('platform.logs.view');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.occurred_at desc) from (
    select l.id,l.occurred_at,l.environment,l.severity,l.source,l.organization_id,
      o.name organization_name,l.plugin_key,l.action,l.message,l.correlation_id,
      l.duration_ms,l.outcome,l.error_code
    from public.platform_log_events l left join public.organizations o on o.id=l.organization_id
    where (p_organization_id is null or l.organization_id=p_organization_id)
      and (p_plugin_key is null or l.plugin_key=p_plugin_key)
    order by l.occurred_at desc limit least(greatest(coalesce(p_limit,100),1),500)
  ) x), '[]'::jsonb);
end
$fn$;

revoke all on function public.developer_session(), public.developer_summary(),
  public.developer_shops(text,integer), public.developer_shop(uuid),
  public.developer_plugins(), public.developer_logs(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.developer_session(), public.developer_summary(),
  public.developer_shops(text,integer), public.developer_shop(uuid),
  public.developer_plugins(), public.developer_logs(uuid,text,integer) to authenticated;
