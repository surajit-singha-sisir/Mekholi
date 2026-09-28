-- 067 — Developer control-plane management.
-- Platform owners can manage tenants and catalogue metadata through one
-- audited, allow-listed command endpoint. Tenant RLS remains unchanged.

update public.platform_roles
set permissions = permissions || array[
  'platform.shops.manage',
  'platform.users.view',
  'platform.users.manage',
  'platform.plugins.manage'
]
where key = 'platform_owner'
  and not ('platform.shops.manage' = any(permissions));

create or replace function public.developer_shop(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare
  v_out jsonb;
begin
  perform app.require_platform_permission('platform.shops.view');
  select to_jsonb(x) into v_out from (
    select o.id, o.name, o.slug, o.shop_type, o.currency, o.timezone, o.locale,
      o.logo_url, o.status, o.created_at, o.updated_at,
      (select count(*) from public.user_organizations uo where uo.organization_id=o.id and uo.is_active) staff_count,
      (select count(*) from public.branches b where b.organization_id=o.id and b.deleted_at is null) branch_count,
      (select count(*) from public.warehouses w where w.organization_id=o.id and w.deleted_at is null) warehouse_count,
      (select count(*) from public.registers r where r.organization_id=o.id and r.is_active) register_count,
      coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', uo.user_id,
        'email', au.email,
        'name', au.raw_user_meta_data->>'full_name',
        'active', uo.is_active,
        'roles', coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'key',r.key,'name',r.name,'branch_id',ur.branch_id) order by r.name)
          from public.user_roles ur join public.roles r on r.id=ur.role_id
          where ur.organization_id=o.id and ur.user_id=uo.user_id), '[]'::jsonb)
      ) order by au.email) from public.user_organizations uo join auth.users au on au.id=uo.user_id where uo.organization_id=o.id),'[]'::jsonb) staff,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',b.id,'name',b.name,'code',b.code,'address',b.address,'phone',b.phone,
        'email',b.email,'timezone',b.timezone,'is_primary',b.is_primary,'deleted_at',b.deleted_at
      ) order by b.is_primary desc,b.name) from public.branches b where b.organization_id=o.id),'[]'::jsonb) branches,
      coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'key',r.key,'name',r.name) order by r.name)
        from public.roles r where r.organization_id=o.id),'[]'::jsonb) roles,
      coalesce((select jsonb_agg(jsonb_build_object('key',p.plugin_key,'version',p.version,'enabled',p.enabled,'status',p.status,'last_error',p.last_error,'enabled_at',p.enabled_at) order by p.plugin_key) from public.plugins p where p.organization_id=o.id),'[]'::jsonb) plugins
    from public.organizations o where o.id=p_organization_id
  ) x;
  if v_out is null then raise exception 'shop_not_found' using errcode='P0002'; end if;
  return v_out;
end
$fn$;

create or replace function public.developer_users(p_search text default null, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
begin
  perform app.require_platform_permission('platform.users.view');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
    select u.id, u.email, u.raw_user_meta_data->>'full_name' as name,
      u.created_at, u.last_sign_in_at, u.banned_until,
      (select count(*) from public.user_organizations uo where uo.user_id=u.id and uo.is_active) organization_count,
      exists(select 1 from public.platform_user_roles pur where pur.user_id=u.id) as is_developer
    from auth.users u
    where nullif(trim(coalesce(p_search,'')), '') is null
       or lower(coalesce(u.email,'') || ' ' || coalesce(u.raw_user_meta_data->>'full_name','') || ' ' || u.id::text)
          like '%' || lower(trim(p_search)) || '%'
    order by u.created_at desc limit least(greatest(coalesce(p_limit,200),1),500)
  ) x), '[]'::jsonb);
end
$fn$;

create or replace function public.developer_command(p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_org uuid;
  v_user uuid;
  v_role uuid;
  v_branch uuid;
  v_email text;
  v_key text;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb := '{}'::jsonb;
  v_original_sub text := current_setting('request.jwt.claim.sub', true);
begin
  if p_action like 'plugin.%' then
    perform app.require_platform_permission('platform.plugins.manage');
  elsif p_action like 'user.%' or p_action like 'staff.%' then
    perform app.require_platform_permission('platform.users.manage');
  else
    perform app.require_platform_permission('platform.shops.manage');
  end if;

  if p_action = 'shop.create' then
    v_email := lower(trim(coalesce(p_payload->>'owner_email','')));
    select id into v_user from auth.users where lower(email)=v_email limit 1;
    if v_user is null then raise exception 'owner_user_not_found' using errcode='P0002'; end if;
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    v_org := public.provision_organization(
      v_user,
      trim(p_payload->>'name'),
      trim(p_payload->>'slug'),
      nullif(trim(p_payload->>'shop_type'),''),
      coalesce(nullif(trim(p_payload->>'currency'),''),'BDT')::char(3),
      coalesce(nullif(trim(p_payload->>'timezone'),''),'Asia/Dhaka'),
      coalesce(nullif(trim(p_payload->>'branch_name'),''),'Main Store'),
      '{}'::text[], '{}'::text[]);
    perform set_config('request.jwt.claim.sub', coalesce(v_original_sub,''), true);
    v_result := jsonb_build_object('id',v_org);

  elsif p_action = 'shop.update' then
    v_org := (p_payload->>'id')::uuid;
    select to_jsonb(o) into v_before from public.organizations o where o.id=v_org;
    if v_before is null then raise exception 'shop_not_found' using errcode='P0002'; end if;
    update public.organizations set
      name=coalesce(nullif(trim(p_payload->>'name'),''),name),
      slug=coalesce(nullif(trim(p_payload->>'slug'),''),slug),
      shop_type=case when p_payload ? 'shop_type' then nullif(trim(p_payload->>'shop_type'),'') else shop_type end,
      currency=coalesce(nullif(trim(p_payload->>'currency'),''),currency)::char(3),
      timezone=coalesce(nullif(trim(p_payload->>'timezone'),''),timezone),
      locale=coalesce(nullif(trim(p_payload->>'locale'),''),locale),
      status=coalesce(nullif(trim(p_payload->>'status'),''),status)
    where id=v_org returning to_jsonb(organizations.*) into v_after;
    v_result := jsonb_build_object('id',v_org);

  elsif p_action = 'shop.delete' then
    v_org := (p_payload->>'id')::uuid;
    select to_jsonb(o) into v_before from public.organizations o where o.id=v_org;
    if v_before is null then raise exception 'shop_not_found' using errcode='P0002'; end if;
    if p_payload->>'confirm' <> v_before->>'slug' then raise exception 'confirmation_mismatch' using errcode='P0001'; end if;
    if length(trim(coalesce(p_payload->>'reason',''))) < 5 then raise exception 'reason_required' using errcode='P0001'; end if;
    delete from public.organizations where id=v_org;
    v_result := jsonb_build_object('deleted',true,'id',v_org);

  elsif p_action = 'branch.save' then
    v_org := (p_payload->>'organization_id')::uuid;
    if not exists(select 1 from public.organizations where id=v_org) then raise exception 'shop_not_found' using errcode='P0002'; end if;
    if nullif(p_payload->>'id','') is null then
      insert into public.branches(organization_id,name,code,address,phone,email,timezone,is_primary)
      values(v_org,trim(p_payload->>'name'),upper(trim(p_payload->>'code')),nullif(trim(p_payload->>'address'),''),nullif(trim(p_payload->>'phone'),''),nullif(trim(p_payload->>'email'),''),nullif(trim(p_payload->>'timezone'),''),coalesce((p_payload->>'is_primary')::boolean,false)) returning id into v_branch;
      insert into public.warehouses(organization_id,branch_id,name,code,is_retail_floor)
      values(v_org,v_branch,trim(p_payload->>'name') || ' Floor',upper(trim(p_payload->>'code')) || '-FLOOR',true);
      insert into public.registers(organization_id,branch_id,name,code)
      values(v_org,v_branch,'Counter 1',upper(trim(p_payload->>'code')) || '-C1');
    else
      v_branch := (p_payload->>'id')::uuid;
      select to_jsonb(b) into v_before from public.branches b where b.id=v_branch and b.organization_id=v_org;
      if v_before is null then raise exception 'branch_not_found' using errcode='P0002'; end if;
      update public.branches set name=trim(p_payload->>'name'),code=upper(trim(p_payload->>'code')),
        address=nullif(trim(p_payload->>'address'),''),phone=nullif(trim(p_payload->>'phone'),''),
        email=nullif(trim(p_payload->>'email'),''),timezone=nullif(trim(p_payload->>'timezone'),''),
        is_primary=coalesce((p_payload->>'is_primary')::boolean,false),deleted_at=null
      where id=v_branch returning to_jsonb(branches.*) into v_after;
    end if;
    if coalesce((p_payload->>'is_primary')::boolean,false) then update public.branches set is_primary=false where organization_id=v_org and id<>v_branch; end if;
    v_result := jsonb_build_object('id',v_branch);

  elsif p_action = 'branch.delete' then
    v_org := (p_payload->>'organization_id')::uuid;
    v_branch := (p_payload->>'id')::uuid;
    select to_jsonb(b) into v_before from public.branches b where b.id=v_branch and b.organization_id=v_org and b.deleted_at is null;
    if v_before is null then raise exception 'branch_not_found' using errcode='P0002'; end if;
    if (v_before->>'is_primary')::boolean then raise exception 'primary_branch_cannot_be_removed' using errcode='P0001'; end if;
    update public.branches set deleted_at=now() where id=v_branch;
    update public.warehouses set deleted_at=now() where branch_id=v_branch;
    update public.registers set is_active=false where branch_id=v_branch;
    v_result := jsonb_build_object('deleted',true,'id',v_branch);

  elsif p_action = 'user.save' then
    v_email := lower(trim(coalesce(p_payload->>'email','')));
    if v_email='' or position('@' in v_email)<2 then raise exception 'invalid_email' using errcode='P0001'; end if;
    if nullif(p_payload->>'id','') is null then
      if length(coalesce(p_payload->>'password',''))<8 then raise exception 'password_too_short' using errcode='P0001'; end if;
      if exists(select 1 from auth.users where lower(email)=v_email) then raise exception 'user_already_exists' using errcode='P0001'; end if;
      v_user := gen_random_uuid();
      insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      values('00000000-0000-0000-0000-000000000000',v_user,'authenticated','authenticated',v_email,extensions.crypt(p_payload->>'password',extensions.gen_salt('bf')),now(),'','','','',jsonb_build_object('provider','email','providers',jsonb_build_array('email')),jsonb_strip_nulls(jsonb_build_object('full_name',nullif(trim(p_payload->>'name'),''))),now(),now());
      insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
      values(v_user::text,v_user,jsonb_build_object('sub',v_user::text,'email',v_email,'email_verified',true,'phone_verified',false),'email',now(),now(),now());
    else
      v_user := (p_payload->>'id')::uuid;
      if not exists(select 1 from auth.users where id=v_user) then raise exception 'user_not_found' using errcode='P0002'; end if;
      update auth.users set email=v_email,raw_user_meta_data=jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb),'{full_name}',to_jsonb(coalesce(p_payload->>'name',''))),updated_at=now() where id=v_user;
      update auth.identities set identity_data=jsonb_set(identity_data,'{email}',to_jsonb(v_email)),updated_at=now() where user_id=v_user and provider='email';
      if length(coalesce(p_payload->>'password',''))>0 then
        if length(p_payload->>'password')<8 then raise exception 'password_too_short' using errcode='P0001'; end if;
        update auth.users set encrypted_password=extensions.crypt(p_payload->>'password',extensions.gen_salt('bf')),updated_at=now() where id=v_user;
      end if;
    end if;
    v_result := jsonb_build_object('id',v_user,'email',v_email);

  elsif p_action = 'user.delete' then
    v_user := (p_payload->>'id')::uuid;
    if v_user=v_actor then raise exception 'cannot_delete_current_user' using errcode='P0001'; end if;
    select email into v_email from auth.users where id=v_user;
    if v_email is null then raise exception 'user_not_found' using errcode='P0002'; end if;
    if lower(trim(coalesce(p_payload->>'confirm','')))<>lower(v_email) then raise exception 'confirmation_mismatch' using errcode='P0001'; end if;
    if length(trim(coalesce(p_payload->>'reason','')))<5 then raise exception 'reason_required' using errcode='P0001'; end if;
    delete from auth.users where id=v_user;
    v_result := jsonb_build_object('deleted',true,'id',v_user);

  elsif p_action = 'staff.save' then
    v_org := (p_payload->>'organization_id')::uuid;
    v_role := (p_payload->>'role_id')::uuid;
    if not exists(select 1 from public.roles where id=v_role and organization_id=v_org) then raise exception 'role_not_found' using errcode='P0002'; end if;
    v_email := lower(trim(coalesce(p_payload->>'email','')));
    if nullif(p_payload->>'user_id','') is null then select id into v_user from auth.users where lower(email)=v_email limit 1; else v_user := (p_payload->>'user_id')::uuid; end if;
    if v_user is null then
      if length(coalesce(p_payload->>'password',''))<8 then raise exception 'password_too_short' using errcode='P0001'; end if;
      v_result := public.developer_command('user.save',jsonb_build_object('email',v_email,'password',p_payload->>'password','name',p_payload->>'name'));
      v_user := (v_result->>'id')::uuid;
    end if;
    if nullif(p_payload->>'branch_id','') is not null then
      v_branch := (p_payload->>'branch_id')::uuid;
      if not exists(select 1 from public.branches where id=v_branch and organization_id=v_org and deleted_at is null) then raise exception 'branch_not_found' using errcode='P0002'; end if;
    end if;
    insert into public.user_organizations(user_id,organization_id,is_active) values(v_user,v_org,true)
    on conflict(user_id,organization_id) do update set is_active=true;
    delete from public.user_roles where user_id=v_user and organization_id=v_org;
    insert into public.user_roles(user_id,organization_id,branch_id,role_id,granted_by) values(v_user,v_org,v_branch,v_role,v_actor);
    v_result := jsonb_build_object('id',v_user);

  elsif p_action = 'staff.remove' then
    v_org := (p_payload->>'organization_id')::uuid;
    v_user := (p_payload->>'user_id')::uuid;
    delete from public.user_roles where user_id=v_user and organization_id=v_org;
    delete from public.user_organizations where user_id=v_user and organization_id=v_org;
    v_result := jsonb_build_object('removed',true,'id',v_user);

  elsif p_action = 'plugin.package.save' then
    v_key := lower(trim(p_payload->>'key'));
    if v_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then raise exception 'invalid_plugin_key' using errcode='P0001'; end if;
    select to_jsonb(pk) into v_before from public.plugin_packages pk where pk.plugin_key=v_key;
    insert into public.plugin_packages(plugin_key,name,category,version,core_api_version,description,dependencies,conflicts)
    values(v_key,trim(p_payload->>'name'),coalesce(nullif(p_payload->>'category',''),'optional'),coalesce(nullif(p_payload->>'version',''),'1.0.0'),coalesce(nullif(p_payload->>'core_api_version',''),'1'),nullif(trim(p_payload->>'description'),''),coalesce(array(select jsonb_array_elements_text(p_payload->'dependencies')),'{}'),coalesce(array(select jsonb_array_elements_text(p_payload->'conflicts')),'{}'))
    on conflict(plugin_key) do update set name=excluded.name,category=excluded.category,version=excluded.version,core_api_version=excluded.core_api_version,description=excluded.description,dependencies=excluded.dependencies,conflicts=excluded.conflicts
    returning to_jsonb(plugin_packages.*) into v_after;
    v_result := jsonb_build_object('key',v_key);

  elsif p_action = 'plugin.package.delete' then
    v_key := p_payload->>'key';
    if p_payload->>'confirm'<>v_key then raise exception 'confirmation_mismatch' using errcode='P0001'; end if;
    if exists(select 1 from public.plugins where plugin_key=v_key) then raise exception 'plugin_is_installed' using errcode='P0001'; end if;
    delete from public.plugin_packages where plugin_key=v_key returning to_jsonb(plugin_packages.*) into v_before;
    if v_before is null then raise exception 'plugin_not_found' using errcode='P0002'; end if;
    v_result := jsonb_build_object('deleted',true,'key',v_key);

  elsif p_action = 'plugin.installation.set' then
    v_org := (p_payload->>'organization_id')::uuid;
    v_key := p_payload->>'key';
    select ur.user_id into v_user from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.organization_id=v_org and r.key='owner' limit 1;
    if v_user is null then raise exception 'shop_owner_not_found' using errcode='P0002'; end if;
    perform set_config('request.jwt.claim.sub',v_user::text,true);
    if coalesce((p_payload->>'enabled')::boolean,false) then
      v_result := public.plugin_enable(v_org,v_key,null,'{}'::jsonb);
    else
      v_result := public.plugin_disable(v_org,v_key);
    end if;
    perform set_config('request.jwt.claim.sub',coalesce(v_original_sub,''),true);

  elsif p_action = 'plugin.installation.remove' then
    v_org := (p_payload->>'organization_id')::uuid;
    v_key := p_payload->>'key';
    delete from public.plugin_data where organization_id=v_org and plugin_key=v_key;
    delete from public.plugin_migrations where organization_id=v_org and plugin_key=v_key;
    delete from public.plugins where organization_id=v_org and plugin_key=v_key;
    v_result := jsonb_build_object('removed',true,'key',v_key);

  else
    raise exception 'unknown_developer_action: %',p_action using errcode='P0001';
  end if;

  perform set_config('request.jwt.claim.sub',coalesce(v_original_sub,''),true);
  insert into public.platform_audit_log(actor_id,action,target_type,target_id,organization_id,reason,before,after)
  values(v_actor,p_action,split_part(p_action,'.',1),coalesce(v_org::text,v_user::text,v_branch::text,v_key),v_org,nullif(trim(p_payload->>'reason'),''),v_before,coalesce(v_after,v_result));
  return v_result;
exception when others then
  perform set_config('request.jwt.claim.sub',coalesce(v_original_sub,''),true);
  raise;
end
$fn$;

revoke all on function public.developer_shop(uuid), public.developer_users(text,integer), public.developer_command(text,jsonb) from public, anon, authenticated;
grant execute on function public.developer_shop(uuid), public.developer_users(text,integer), public.developer_command(text,jsonb) to authenticated;
