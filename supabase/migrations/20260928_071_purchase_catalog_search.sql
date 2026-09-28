-- 071 — Buy-side catalogue search for purchase orders.
-- POS catalogue rows are keyed by existing stock balances. A product stocked
-- in branch A but never stocked in branch B therefore has no POS row for B,
-- which made it impossible to order that product into B. Purchase search must
-- return every active variant and project the selected warehouse balance as 0.

create or replace function public.purchase_products(
  p_warehouse_id uuid,
  p_search text default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_org uuid;
begin
  select organization_id into v_org
  from public.warehouses
  where id=p_warehouse_id and deleted_at is null;
  if v_org is null then raise exception 'warehouse_not_found' using errcode='P0002'; end if;
  perform app.require_org(v_org);
  perform app.require_permission('purchases.create');

  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.name,x.variant_name nulls first)
    from (
      select
        p.organization_id,
        p.id as product_id,
        p.name,
        p.sku,
        p.description,
        p.image_url,
        p.track_stock,
        p.allow_negative,
        p.tax_inclusive,
        p.category_id,
        c.name as category_name,
        p.reorder_point,
        p.metadata,
        v.id as variant_id,
        v.name_suffix as variant_name,
        coalesce(v.sku,p.sku) as effective_sku,
        coalesce(v.price_override,p.selling_price) as price,
        coalesce(v.cost_override,p.cost_price) as cost,
        v.is_default,
        u.symbol as unit_label,
        coalesce(u.is_decimal,false) as decimal_quantity,
        coalesce(t.rate,0) as tax_rate,
        p_warehouse_id as warehouse_id,
        coalesce(sb.quantity,0) as available
      from public.products p
      join public.product_variants v on v.product_id=p.id and v.deleted_at is null and v.is_active
      left join public.product_units u on u.id=p.unit_id
      left join public.taxes t on t.id=p.tax_id and t.is_active
      left join public.product_categories c on c.id=p.category_id
      left join public.stock_balances sb on sb.variant_id=v.id and sb.warehouse_id=p_warehouse_id
      where p.organization_id=v_org
        and p.deleted_at is null
        and p.is_active
        and (
          nullif(trim(coalesce(p_search,'')),'') is null
          or p.search_text ilike '%' || trim(p_search) || '%'
          or p.name ilike '%' || trim(p_search) || '%'
          or coalesce(v.sku,p.sku,'') ilike '%' || trim(p_search) || '%'
        )
      order by p.name,v.name_suffix nulls first
      limit least(greatest(coalesce(p_limit,20),1),100)
    ) x
  ),'[]'::jsonb);
end
$fn$;

revoke all on function public.purchase_products(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.purchase_products(uuid,text,integer) to authenticated;
