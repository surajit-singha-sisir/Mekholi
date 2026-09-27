-- 065 — The accountant can read sales.
--
-- Found by a navigation test: the seeded accountant role held
-- `sales.view_all_branches` — the *stronger* cross-branch permission — but
-- not plain `sales.view`, so the Sales screen (menu and route alike) was
-- hidden from the one role whose whole job is the sales figures. The menu
-- was honestly reflecting a dishonest rule.
--
-- Two repairs, in the only order that is safe to re-run:
--   1. Backfill: every existing organization's system accountant role gains
--      `sales.view` (idempotent, on conflict do nothing).
--   2. Provisioning: future organizations are born with the rule correct.

-- ── 1. Existing shops ──────────────────────────────────────────────────────
insert into public.role_permissions (organization_id, role_id, permission_id)
select r.organization_id, r.id, p.id
  from public.roles r
  cross join public.permissions p
 where r.key = 'accountant'
   and r.is_system
   and p.key = 'sales.view'
on conflict do nothing;

-- ── 2. Future shops ────────────────────────────────────────────────────────
create or replace function public.provision_organization(
  p_owner_user_id uuid,
  p_org_name      text,
  p_slug          text,
  p_shop_type     text,
  p_currency      char(3)   default 'BDT',
  p_timezone      text      default 'Asia/Dhaka',
  p_branch_name   text      default 'Main Store',
  p_categories    text[]    default '{}',
  p_payment_keys  text[]    default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org       uuid := gen_random_uuid();
  v_branch    uuid := gen_random_uuid();
  v_warehouse uuid := gen_random_uuid();
  v_register  uuid := gen_random_uuid();
  v_role      uuid;
  v_unit      text;
  v_key       text;
  v_name      text;
  v_symbol    text;
  v_decimal   boolean;
  v_sort      int := 0;
begin
  if not exists (select 1 from auth.users where id = p_owner_user_id) then
    raise exception 'owner_user_not_found: %', p_owner_user_id
      using errcode = 'P0002';
  end if;

  -- A caller may provision an organization for themselves and nobody else.
  -- The service role (auth.uid() is null) acts on a user's behalf during
  -- signup and is exempt.
  if auth.uid() is not null and p_owner_user_id <> auth.uid() then
    raise exception 'cannot provision an organization for another user'
      using errcode = '42501';
  end if;

  -- ── Organization ────────────────────────────────────────────────────────
  insert into public.organizations
        (id, name, slug, shop_type, currency, timezone)
  values (v_org, p_org_name, p_slug, p_shop_type, p_currency, p_timezone);

  insert into public.user_organizations (user_id, organization_id)
  values (p_owner_user_id, v_org);

  insert into public.branches
        (id, organization_id, name, code, is_primary)
  values (v_branch, v_org, p_branch_name, 'MAIN', true);

  insert into public.warehouses
        (id, organization_id, branch_id, name, code, is_retail_floor)
  values (v_warehouse, v_org, v_branch, p_branch_name || ' Floor', 'FLOOR', true);

  insert into public.registers
        (id, organization_id, branch_id, name, code)
  values (v_register, v_org, v_branch, 'Counter 1', 'C1');

  -- ── Roles ───────────────────────────────────────────────────────────────
  insert into public.roles (id, organization_id, key, name, is_system)
  values
    (gen_random_uuid(), v_org, 'owner',             'Owner',             true),
    (gen_random_uuid(), v_org, 'admin',             'Admin',             true),
    (gen_random_uuid(), v_org, 'manager',           'Manager',           true),
    (gen_random_uuid(), v_org, 'cashier',           'Cashier',           true),
    (gen_random_uuid(), v_org, 'inventory_manager', 'Inventory Manager', true),
    (gen_random_uuid(), v_org, 'accountant',        'Accountant',        true);

  -- Owner: the '*' wildcard, which app.has_permission() matches against every
  -- key — including permissions plugins add later. That is intended for the
  -- owner role and for nothing else.
  insert into public.permissions (key, label, category, description)
  values ('*', 'All permissions', 'system',
          'Wildcard grant. Matched at check time, so it covers permissions added later.')
  on conflict (key) do nothing;

  select id into v_role from public.roles
   where organization_id = v_org and key = 'owner';
  insert into public.role_permissions (organization_id, role_id, permission_id)
  select v_org, v_role, id from public.permissions where key = '*';

  -- Admin: explicit grants of everything that exists today. Deliberately not
  -- a wildcard, so enabling a plugin later does not silently widen admin
  -- rights without the Plugins screen showing the impact (docs/07 §4).
  select id into v_role from public.roles
   where organization_id = v_org and key = 'admin';
  insert into public.role_permissions (organization_id, role_id, permission_id)
  select v_org, v_role, id from public.permissions
   where key <> '*' and key <> 'users.delete';

  -- Manager: runs the shop, cannot manage users or plugins.
  select id into v_role from public.roles
   where organization_id = v_org and key = 'manager';
  insert into public.role_permissions (organization_id, role_id, permission_id)
  select v_org, v_role, id from public.permissions
   where key = 'dashboard.view'
      or key like 'sales.%'      and key <> 'sales.view_all_branches'
      or key like 'products.%'   and key not in ('products.delete','products.import','products.export')
      or key like 'inventory.%'
      or key like 'purchases.%'  and key <> 'purchases.approve'
      or key like 'customers.%'  and key <> 'customers.delete'
      or key like 'suppliers.%'
      or key like 'expenses.%'   and key <> 'expenses.delete'
      or key in ('reports.view','analytics.view','register.open','register.close',
                 'register.adjust_cash');

  -- Cashier: sells. Note sales.discount is NOT granted by default — whether a
  -- cashier may discount is a policy decision each shop makes differently,
  -- so it is a permission rather than a setting (docs/07 §5).
  select id into v_role from public.roles
   where organization_id = v_org and key = 'cashier';
  insert into public.role_permissions (organization_id, role_id, permission_id)
  select v_org, v_role, id from public.permissions
   where key in ('dashboard.view','sales.view','sales.create','sales.hold',
                 'sales.resume','products.view','customers.view','customers.create',
                 'inventory.view','register.open','register.close');

  select id into v_role from public.roles
   where organization_id = v_org and key = 'inventory_manager';
  insert into public.role_permissions (organization_id, role_id, permission_id)
  select v_org, v_role, id from public.permissions
   where key = 'dashboard.view'
      or key like 'products.%'
      or key like 'inventory.%'
      or key like 'purchases.%'
      or key like 'suppliers.%'
      or key = 'reports.view';

  select id into v_role from public.roles
   where organization_id = v_org and key = 'accountant';
  insert into public.role_permissions (organization_id, role_id, permission_id)
  select v_org, v_role, id from public.permissions
   where key = 'dashboard.view'
      or key like 'reports.%'
      or key = 'analytics.view'
      or key like 'expenses.%'
      or key = 'purchases.view'
      -- 065: an accountant reads sales. They already held the *stronger*
      -- cross-branch grant while the plain one was missing, which hid the
      -- whole Sales screen from the person whose job is the sales figures.
      or key = 'sales.view'
      or key = 'sales.view_all_branches';

  -- ── Owner membership ────────────────────────────────────────────────────
  insert into public.user_roles (user_id, organization_id, branch_id, role_id, granted_by)
  select p_owner_user_id, v_org, null, id, p_owner_user_id
    from public.roles where organization_id = v_org and key = 'owner';

  -- ── Units ───────────────────────────────────────────────────────────────
  foreach v_unit in array array[
    'Each|ea|false', 'Kilogram|kg|true', 'Gram|g|true', 'Litre|L|true',
    'Millilitre|mL|true', 'Metre|m|true', 'Feet|ft|true', 'Dozen|dz|false',
    'Pack|pk|false', 'Box|bx|false', 'Pair|pr|false', 'Set|set|false',
    'Hour|hr|false'
  ]
  loop
    v_name    := split_part(v_unit, '|', 1);
    v_symbol  := split_part(v_unit, '|', 2);
    v_decimal := split_part(v_unit, '|', 3) = 'true';
    v_sort    := v_sort + 10;
    insert into public.product_units
          (organization_id, name, symbol, is_decimal, sort_order)
    values (v_org, v_name, v_symbol, v_decimal, v_sort)
    on conflict (organization_id, name) do nothing;
  end loop;

  -- ── Payment methods ─────────────────────────────────────────────────────
  -- Generic defaults. Country-specific methods (bKash, Nagad, PayPal, …) are
  -- added by the setup wizard from the shop-type profile, never hardcoded
  -- here (spec §15).
  if cardinality(p_payment_keys) = 0 then
    insert into public.payment_methods
          (organization_id, key, name, type, is_cash, sort_order)
    values
      (v_org, 'cash',    'Cash',           'cash',   true,  10),
      (v_org, 'mobile',  'Mobile Banking', 'mobile', false, 20),
      (v_org, 'card',    'Card',           'card',   false, 30),
      (v_org, 'bank',    'Bank Transfer',  'bank',   false, 40),
      (v_org, 'credit',  'Credit',         'credit', false, 50),
      (v_org, 'other',   'Other',          'other',  false, 60);
  else
    v_sort := 0;
    foreach v_key in array p_payment_keys loop
      v_sort := v_sort + 10;
      insert into public.payment_methods
            (organization_id, key, name, type, is_cash, sort_order)
      values (v_org, lower(v_key), initcap(v_key),
              case when lower(v_key) = 'cash' then 'cash' else 'other' end,
              lower(v_key) = 'cash',
              v_sort)
      on conflict (organization_id, key) do nothing;
    end loop;
  end if;

  -- ── Categories ──────────────────────────────────────────────────────────
  v_sort := 0;
  foreach v_name in array p_categories loop
    v_sort := v_sort + 10;
    insert into public.product_categories
          (organization_id, name, slug, sort_order)
    values (v_org, v_name, lower(replace(v_name, ' ', '-')), v_sort)
    on conflict do nothing;
  end loop;

  -- ── Opening the audit trail ─────────────────────────────────────────────
  insert into public.audit_logs
        (organization_id, actor_id, action, entity_type, entity_id, after)
  values (v_org, p_owner_user_id, 'organization.provisioned', 'organization',
          v_org,
          jsonb_build_object('name', p_org_name, 'shop_type', p_shop_type,
                             'currency', p_currency));

  insert into public.outbox
        (organization_id, event_type, aggregate_type, aggregate_id, payload)
  values (v_org, 'organization.provisioned', 'organization', v_org,
          jsonb_build_object('organization_id', v_org, 'shop_type', p_shop_type));

  return v_org;
end;
$fn$;


-- The repair proves itself: after this migration no system accountant role
-- anywhere lacks sales.view.
do $assert$
begin
  if exists (
    select 1 from public.roles r
     where r.key = 'accountant' and r.is_system
       and not exists (
         select 1 from public.role_permissions rp
           join public.permissions p on p.id = rp.permission_id
          where rp.role_id = r.id and p.key = 'sales.view'
       )
  ) then
    raise exception 'an accountant role is still blind to sales';
  end if;
end;
$assert$;
