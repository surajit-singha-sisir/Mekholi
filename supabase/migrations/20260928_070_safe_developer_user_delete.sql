-- 070 — Safe developer user deletion.
-- Business and audit rows retain actor UUIDs for accountability, so deleting
-- auth.users physically is incorrect. Revoke access and scrub the account
-- instead; the control plane no longer lists it and GoTrue cannot sign it in.

create or replace function public.developer_user_delete(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_email text;
begin
  perform app.require_platform_permission('platform.users.manage');
  if p_user_id = v_actor then raise exception 'cannot_delete_current_user' using errcode='P0001'; end if;

  select email into v_email from auth.users where id=p_user_id and deleted_at is null;
  if v_email is null then raise exception 'user_not_found' using errcode='P0002'; end if;

  delete from public.user_roles where user_id=p_user_id;
  delete from public.user_organizations where user_id=p_user_id;
  delete from public.platform_user_roles where user_id=p_user_id;
  delete from public.platform_support_sessions where user_id=p_user_id;
  delete from auth.sessions where user_id=p_user_id;
  delete from auth.identities where user_id=p_user_id;

  update auth.users
  set email='deleted+' || p_user_id::text || '@deleted.invalid',
      phone=null,
      encrypted_password=extensions.crypt(gen_random_uuid()::text,extensions.gen_salt('bf')),
      raw_app_meta_data=jsonb_build_object('provider','deleted','providers','[]'::jsonb),
      raw_user_meta_data=jsonb_build_object('deleted',true),
      banned_until=now()+interval '100 years',
      deleted_at=now(),
      updated_at=now()
  where id=p_user_id;

  insert into public.platform_audit_log(actor_id,action,target_type,target_id,reason,before,after)
  values(v_actor,'user.delete','user',p_user_id::text,'Deleted from developer control plane',
    jsonb_build_object('email',v_email),jsonb_build_object('deleted',true,'access_revoked',true));

  return jsonb_build_object('deleted',true,'id',p_user_id);
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
    where u.deleted_at is null
      and (nullif(trim(coalesce(p_search,'')), '') is null
       or lower(coalesce(u.email,'') || ' ' || coalesce(u.raw_user_meta_data->>'full_name','') || ' ' || u.id::text)
          like '%' || lower(trim(p_search)) || '%')
    order by u.created_at desc limit least(greatest(coalesce(p_limit,200),1),500)
  ) x), '[]'::jsonb);
end
$fn$;

revoke all on function public.developer_user_delete(uuid) from public, anon, authenticated;
grant execute on function public.developer_user_delete(uuid) to authenticated;
