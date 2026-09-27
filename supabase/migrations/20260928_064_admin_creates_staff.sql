-- 064: staff accounts the owner writes by hand — email + password, no
-- confirmation email, no magic link.
--
-- The invite flow (052) assumed staff have reachable inboxes. In practice a
-- cashier's email is often created *for* the job, on the shop's phone, and
-- the confirmation mail is one more thing to go wrong. So the owner or admin
-- now sets the address and the password directly, tells them across the
-- counter, and the account signs in immediately.
--
-- The function is SECURITY DEFINER and writes auth.users itself with the
-- email already confirmed. That is deliberate and narrow:
--   * only `users.create` holders in the org can call it,
--   * an address that already has an auth account is *linked*, never
--     re-passworded — this function can add someone to a shop, but it can
--     never hijack an existing login,
--   * the password is hashed with bcrypt in-database and stored nowhere else.
-- The invite flow stays available in the database; the UI simply stops
-- leading with it.

create or replace function public.create_staff_account(
  p_organization_id uuid,
  p_email          text,
  p_password       text,
  p_name           text,
  p_role_id        uuid,
  p_branch_id      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_email   text := lower(trim(p_email));
  v_user_id uuid;
  v_created boolean := false;
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('users.create');

  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;

  if length(coalesce(p_password, '')) < 8 then
    raise exception 'password_too_short' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.roles
     where id = p_role_id and organization_id = p_organization_id
  ) then
    raise exception 'role_not_found' using errcode = 'P0002';
  end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches
     where id = p_branch_id and organization_id = p_organization_id and deleted_at is null
  ) then
    raise exception 'branch_not_found' using errcode = 'P0002';
  end if;

  select id into v_user_id from auth.users where lower(email) = v_email limit 1;

  if v_user_id is not null and exists (
    select 1 from public.user_organizations
     where organization_id = p_organization_id
       and user_id = v_user_id
       and is_active
  ) then
    raise exception 'staff_already_member' using errcode = 'P0001';
  end if;

  if v_user_id is null then
    -- A brand-new login, born confirmed. The empty-string token columns are
    -- not decoration: GoTrue scans them as strings and trips over NULLs.
    v_user_id := gen_random_uuid();

    insert into auth.users
      (instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, confirmation_token, recovery_token,
       email_change, email_change_token_new,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at)
    values
      ('00000000-0000-0000-0000-000000000000', v_user_id,
       'authenticated', 'authenticated', v_email,
       extensions.crypt(p_password, extensions.gen_salt('bf')),
       now(), '', '', '', '',
       jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
       jsonb_strip_nulls(jsonb_build_object('full_name', nullif(trim(coalesce(p_name, '')), ''))),
       now(), now());

    insert into auth.identities
      (provider_id, user_id, identity_data, provider,
       last_sign_in_at, created_at, updated_at)
    values
      (v_user_id::text, v_user_id,
       jsonb_build_object(
         'sub', v_user_id::text,
         'email', v_email,
         'email_verified', true,
         'phone_verified', false),
       'email', now(), now(), now());

    v_created := true;
  end if;

  insert into public.user_organizations (user_id, organization_id)
  values (v_user_id, p_organization_id)
  on conflict (user_id, organization_id)
  do update set is_active = true;

  insert into public.user_roles
    (user_id, organization_id, branch_id, role_id, granted_by)
  values
    (v_user_id, p_organization_id, p_branch_id, p_role_id, auth.uid())
  on conflict (user_id, organization_id, branch_id, role_id) do nothing;

  -- Any pending invitation for this address is now moot: the account exists.
  update public.organization_invitations
     set accepted_at = now(), accepted_user_id = v_user_id
   where organization_id = p_organization_id
     and email = v_email
     and accepted_at is null;

  return jsonb_build_object(
    'user_id', v_user_id,
    'email', v_email,
    'created', v_created
  );
end;
$fn$;

comment on function public.create_staff_account(uuid, text, text, text, uuid, uuid) is
  'Owner/admin creates a ready-to-use staff login (email confirmed, password set) and grants org membership — no confirmation email. An existing auth account is linked, never re-passworded.';

-- Reachable only through the authenticated API; the permission check inside
-- is the real gate.
revoke all on function public.create_staff_account(uuid, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_staff_account(uuid, text, text, text, uuid, uuid) to authenticated;

do $assert$
begin
  if has_function_privilege('anon', 'public.create_staff_account(uuid,text,text,text,uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.create_staff_account(uuid,text,text,text,uuid,uuid)', 'EXECUTE')
  then
    raise exception 'create_staff_account grants are wrong';
  end if;
end;
$assert$;
