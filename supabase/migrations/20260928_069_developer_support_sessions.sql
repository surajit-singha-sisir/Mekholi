-- 069 — Short-lived, audited developer support sessions.
-- A platform owner can open one shop in the normal shop shell without learning
-- an owner's credentials or receiving a permanent tenant membership.

create table public.platform_support_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  reason text not null,
  ticket text,
  access_mode text not null default 'full' check (access_mode in ('read_only','full')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (expires_at > started_at)
);

create index platform_support_sessions_active_idx
  on public.platform_support_sessions(user_id, expires_at desc)
  where ended_at is null;

alter table public.platform_support_sessions enable row level security;
alter table public.platform_support_sessions force row level security;
revoke all on public.platform_support_sessions from public, anon, authenticated;

create or replace function app.active_support_org_id()
returns uuid language sql stable security definer set search_path = public as $fn$
  select s.organization_id
  from public.platform_support_sessions s
  where s.user_id = auth.uid()
    and s.ended_at is null
    and s.expires_at > now()
  order by s.started_at desc
  limit 1
$fn$;

create or replace function app.current_org_ids()
returns uuid[] language sql stable security definer set search_path = public as $fn$
  select coalesce(array_agg(distinct organization_id), '{}')
  from (
    select uo.organization_id
    from public.user_organizations uo
    where uo.user_id = auth.uid() and uo.is_active
    union all
    select app.active_support_org_id()
  ) visible
  where organization_id is not null
$fn$;

create or replace function app.has_permission(p_key text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select app.active_support_org_id() is not null
    or exists (
      select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions p on p.id = rp.permission_id
      where ur.user_id = auth.uid()
        and ur.organization_id = any(app.current_org_ids())
        and (ur.branch_id is null or ur.branch_id = app.current_branch_id())
        and (p.key = p_key or p.key = '*' or p.key = split_part(p_key, '.', 1) || '.*')
    )
$fn$;

create or replace function app.visible_branch_ids(p_org uuid)
returns uuid[] language sql stable security definer set search_path = public as $fn$
  select case
    when app.active_support_org_id() = p_org then (
      select coalesce(array_agg(id), '{}') from public.branches
      where organization_id = p_org and deleted_at is null
    )
    when exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and organization_id = p_org and branch_id is null
    ) then (
      select coalesce(array_agg(id), '{}') from public.branches
      where organization_id = p_org and deleted_at is null
    )
    else (
      select coalesce(array_agg(branch_id), '{}') from public.user_roles
      where user_id = auth.uid() and organization_id = p_org and branch_id is not null
    )
  end
$fn$;

create or replace function public.session_payload()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $fn$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'organizations', coalesce((
      select jsonb_agg(org order by org->>'name')
      from (
        select jsonb_build_object(
          'organization_id', access.organization_id,
          'name', o.name,
          'slug', o.slug,
          'currency', o.currency,
          'timezone', o.timezone,
          'shop_type', o.shop_type,
          'role_names', case when access.is_support then jsonb_build_array('Developer support') else coalesce((
            select jsonb_agg(r.name order by r.name)
            from public.user_roles ur join public.roles r on r.id=ur.role_id
            where ur.user_id=auth.uid() and ur.organization_id=access.organization_id
          ),'[]'::jsonb) end,
          'permissions', case when access.is_support then coalesce((
            select jsonb_agg(p.key order by p.key) from public.permissions p where p.key<>'*'
          ),'[]'::jsonb) else coalesce((
            select jsonb_agg(distinct p.key order by p.key)
            from public.user_roles ur
            join public.roles r on r.id=ur.role_id
            join public.role_permissions rp on rp.role_id=r.id
            join public.permissions granted on granted.id=rp.permission_id
            join public.permissions p on (p.key=granted.key or granted.key='*' or (right(granted.key,2)='.*' and split_part(p.key,'.',1)=split_part(granted.key,'.',1)))
            where ur.user_id=auth.uid() and ur.organization_id=access.organization_id and p.key<>'*'
          ),'[]'::jsonb) end,
          'is_owner', access.is_support or exists(
            select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id
            where ur.user_id=auth.uid() and ur.organization_id=access.organization_id and r.key='owner'
          ),
          'role_keys', case when access.is_support then jsonb_build_array('owner') else coalesce((
            select jsonb_agg(r.key order by r.key)
            from public.user_roles ur join public.roles r on r.id=ur.role_id
            where ur.user_id=auth.uid() and ur.organization_id=access.organization_id
          ),'[]'::jsonb) end,
          'is_support_session', access.is_support,
          'support_session_id', access.support_session_id,
          'support_expires_at', access.support_expires_at
        ) org
        from (
          select uo.organization_id, false as is_support, null::uuid as support_session_id, null::timestamptz as support_expires_at
          from public.user_organizations uo
          where uo.user_id=auth.uid() and uo.is_active
          union all
          select s.organization_id, true, s.id, s.expires_at
          from public.platform_support_sessions s
          where s.user_id=auth.uid() and s.ended_at is null and s.expires_at>now()
            and not exists(select 1 from public.user_organizations uo where uo.user_id=auth.uid() and uo.organization_id=s.organization_id and uo.is_active)
          order by support_expires_at desc nulls last
          limit 100
        ) access
        join public.organizations o on o.id=access.organization_id
      ) rows_
    ),'[]'::jsonb)
  )
$fn$;

create or replace function public.developer_support_start(
  p_organization_id uuid,
  p_reason text,
  p_ticket text default null,
  p_minutes integer default 30
)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_id uuid;
  v_expires timestamptz;
begin
  perform app.require_platform_permission('platform.shops.manage');
  if not exists(select 1 from public.organizations where id=p_organization_id) then raise exception 'shop_not_found' using errcode='P0002'; end if;
  if length(trim(coalesce(p_reason,'')))<5 then raise exception 'support_reason_required' using errcode='P0001'; end if;
  update public.platform_support_sessions set ended_at=now() where user_id=auth.uid() and ended_at is null;
  v_expires := now() + make_interval(mins => least(greatest(coalesce(p_minutes,30),5),60));
  insert into public.platform_support_sessions(user_id,organization_id,reason,ticket,access_mode,expires_at)
  values(auth.uid(),p_organization_id,trim(p_reason),nullif(trim(coalesce(p_ticket,'')),''),'full',v_expires)
  returning id into v_id;
  insert into public.platform_audit_log(actor_id,action,target_type,target_id,organization_id,reason,after)
  values(auth.uid(),'support.start','support_session',v_id::text,p_organization_id,trim(p_reason),jsonb_build_object('ticket',nullif(trim(coalesce(p_ticket,'')),''),'expires_at',v_expires,'access_mode','full'));
  return jsonb_build_object('id',v_id,'organization_id',p_organization_id,'expires_at',v_expires,'access_mode','full');
end
$fn$;

create or replace function public.developer_support_end()
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_session record;
begin
  select * into v_session from public.platform_support_sessions
  where user_id=auth.uid() and ended_at is null order by started_at desc limit 1;
  if v_session.id is null then return jsonb_build_object('ended',false); end if;
  update public.platform_support_sessions set ended_at=now() where id=v_session.id;
  insert into public.platform_audit_log(actor_id,action,target_type,target_id,organization_id,reason,after)
  values(auth.uid(),'support.end','support_session',v_session.id::text,v_session.organization_id,v_session.reason,jsonb_build_object('ended_at',now()));
  return jsonb_build_object('ended',true,'organization_id',v_session.organization_id);
end
$fn$;

revoke all on function app.active_support_org_id() from public, anon, authenticated;
revoke all on function public.developer_support_start(uuid,text,text,integer), public.developer_support_end() from public, anon, authenticated;
grant execute on function public.developer_support_start(uuid,text,text,integer), public.developer_support_end() to authenticated;
