-- 073 — Discarding a held sale from the till.
--
-- A parked cart is not always resumed. A customer changes their mind, walks
-- off, or the cashier held the same basket twice — and until now the only way
-- to clear a hold was to resume it and then clear the cart, which is two wrong
-- moves to undo one. This gives the "Held sales" drawer a delete of its own.
--
-- It does exactly what complete_sale already does to the hold it lands on
-- (migration 021): flips HELD → CANCELLED. The row is kept, not deleted, so the
-- audit trail still shows the basket existed and who ended it; it simply stops
-- appearing in the held list (which reads status = 'HELD') and in the sales
-- history (which excludes DRAFT and CANCELLED). No stock ever moved for a hold,
-- so there is nothing to give back.
--
-- Guarded by `sales.resume`: whoever may pull a held cart back may also throw
-- it away. Nobody who cannot touch holds at all gets a delete button.

create or replace function public.discard_held_sale(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org    uuid;
  v_status public.sale_status;
begin
  select organization_id, status into v_org, v_status
    from public.sales where id = p_sale_id;

  if v_org is null then
    raise exception 'sale_not_found: %', p_sale_id using errcode = 'P0002';
  end if;

  perform app.require_org(v_org);
  perform app.require_permission('sales.resume');

  -- Only a hold may be discarded this way. A completed or refunded sale is a
  -- financial record with its own reversal path (refund_sale); letting this
  -- cancel one would erase money that was actually taken.
  if v_status <> 'HELD' then
    raise exception 'sale_not_held: status is %', v_status using errcode = '22023';
  end if;

  update public.sales
     set status = 'CANCELLED'
   where id = p_sale_id and status = 'HELD';

  insert into public.outbox
        (organization_id, event_type, aggregate_type, aggregate_id, payload)
  values (v_org, 'sale.discarded', 'sale', p_sale_id,
          jsonb_build_object('sale_id', p_sale_id));
end;
$fn$;

-- The grants discipline of 018: callable by a signed-in user (the function
-- re-checks org and permission itself), never by anon.
revoke execute on function public.discard_held_sale(uuid) from anon, public;
grant execute on function public.discard_held_sale(uuid) to authenticated;
