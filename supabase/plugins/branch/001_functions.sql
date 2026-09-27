-- ── The branch book ───────────────────────────────────────────────────────
-- Every branch, with what it did today and this week — the head office
-- view. Reads gated on `reports.view`: watching branches is reporting.
-- Minor units everywhere, like every jsonb the client reads.
create or replace function public.branch_list(
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
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('reports.view');

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', b.id,
             'name', b.name,
             'code', b.code,
             'address', b.address,
             'phone', b.phone,
             'is_primary', b.is_primary,
             'registers', (select count(*) from public.registers r
                            where r.branch_id = b.id and r.is_active),
             'today_sales', (
               select count(*) from public.sales s
                where s.branch_id = b.id
                  and s.status in ('COMPLETED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED')
                  and (s.created_at at time zone 'Asia/Dhaka')::date = v_today),
             'today_total_minor', coalesce((
               select round(sum(s.total) * 100)::bigint from public.sales s
                where s.branch_id = b.id
                  and s.status in ('COMPLETED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED')
                  and (s.created_at at time zone 'Asia/Dhaka')::date = v_today), 0),
             'week_sales', (
               select count(*) from public.sales s
                where s.branch_id = b.id
                  and s.status in ('COMPLETED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED')
                  and s.created_at >= now() - interval '7 days'),
             'week_total_minor', coalesce((
               select round(sum(s.total) * 100)::bigint from public.sales s
                where s.branch_id = b.id
                  and s.status in ('COMPLETED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED')
                  and s.created_at >= now() - interval '7 days'), 0),
             'open_dues_minor', coalesce((
               select round(sum(s.total - s.paid_total) * 100)::bigint
                 from public.sales s
                where s.branch_id = b.id and s.status = 'PARTIALLY_PAID'), 0)
           ) order by b.is_primary desc, b.name)
      from public.branches b
     where b.organization_id = p_organization_id
       and b.deleted_at is null
  ), '[]'::jsonb);
end
$fn$;

-- ── Opening and renaming branches ─────────────────────────────────────────
-- Gated on `settings.business`, the same permission that lets someone edit
-- the organization itself — opening a branch is business structure, not
-- day-to-day selling. A new branch arrives *complete*: with the retail
-- floor and the first counter, the way provisioning builds the main one
-- (017) — a branch the till cannot sell from would not be a branch.
create or replace function public.branch_save(
  p_organization_id uuid,
  p_args jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id      uuid := nullif(p_args ->> 'id', '')::uuid;
  v_name    text := nullif(trim(coalesce(p_args ->> 'name', '')), '');
  v_code    text := upper(nullif(trim(coalesce(p_args ->> 'code', '')), ''));
  v_address text := nullif(trim(coalesce(p_args ->> 'address', '')), '');
  v_phone   text := nullif(trim(coalesce(p_args ->> 'phone', '')), '');
  v_primary boolean := coalesce((p_args ->> 'is_primary')::boolean, false);
  v_branch  public.branches;
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('settings.business');

  if v_name is null then
    raise exception 'branch_needs_name' using errcode = '22023';
  end if;
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9-]{0,11}$' then
    raise exception 'branch_needs_code: letters, digits and dashes, 12 at most'
      using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.branches (organization_id, name, code, address, phone, is_primary)
    values (p_organization_id, v_name, v_code, v_address, v_phone, false)
    returning * into v_branch;

    -- The floor and the counter, so the branch can sell tomorrow morning.
    insert into public.warehouses (organization_id, branch_id, name, code, is_retail_floor)
    values (p_organization_id, v_branch.id, v_name || ' Floor', v_code || '-FLOOR', true);

    insert into public.registers (organization_id, branch_id, name, code)
    values (p_organization_id, v_branch.id, 'Counter 1', v_code || '-C1');
  else
    update public.branches
       set name = v_name,
           code = v_code,
           address = v_address,
           phone = v_phone
     where id = v_id
       and organization_id = p_organization_id
       and deleted_at is null
    returning * into v_branch;
    if v_branch.id is null then
      raise exception 'branch_not_found: %', v_id using errcode = 'P0002';
    end if;
  end if;

  -- Exactly one main branch. Making this one primary demotes the others in
  -- the same statement, so no window exists where the shop has two heads.
  if v_primary and not v_branch.is_primary then
    update public.branches
       set is_primary = (id = v_branch.id)
     where organization_id = p_organization_id
       and deleted_at is null;
    v_branch.is_primary := true;
  end if;

  return jsonb_build_object(
    'id', v_branch.id,
    'name', v_branch.name,
    'code', v_branch.code,
    'is_primary', v_branch.is_primary
  );
end
$fn$;

revoke execute on function public.branch_list(uuid, jsonb) from public, anon;
revoke execute on function public.branch_save(uuid, jsonb) from public, anon;
grant execute on function public.branch_list(uuid, jsonb) to authenticated;
grant execute on function public.branch_save(uuid, jsonb) to authenticated;
