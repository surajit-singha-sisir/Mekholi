-- 068 — Connect the developer log viewer to activity the shop system already records.
-- The dedicated telemetry table remains available for workers and external
-- ingestion, while the read API also projects tenant audits, control-plane
-- audits and current plugin failures into one safe operational timeline.

create or replace function public.developer_logs(
  p_organization_id uuid default null,
  p_plugin_key text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform app.require_platform_permission('platform.logs.view');

  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.occurred_at desc)
    from (
      select * from (
        select
          l.id::text as id,
          l.occurred_at,
          l.environment,
          l.severity,
          l.source,
          l.organization_id,
          o.name as organization_name,
          l.plugin_key,
          l.action,
          l.message,
          l.correlation_id,
          l.duration_ms,
          l.outcome,
          l.error_code
        from public.platform_log_events l
        left join public.organizations o on o.id = l.organization_id

        union all

        select
          'platform-audit:' || a.id::text,
          a.created_at,
          'production',
          'info',
          'control-plane',
          a.organization_id,
          o.name,
          case when a.target_type = 'plugin' then a.target_id else null end,
          a.action,
          concat('Developer action on ', a.target_type,
            case when a.target_id is not null then ' ' || a.target_id else '' end,
            case when a.reason is not null then ' — ' || a.reason else '' end),
          null,
          null,
          'recorded',
          null
        from public.platform_audit_log a
        left join public.organizations o on o.id = a.organization_id

        union all

        select
          'tenant-audit:' || a.id::text,
          a.created_at,
          'production',
          'info',
          'shop-audit',
          a.organization_id,
          o.name,
          case
            when a.entity_type = 'plugins' then coalesce(a.after->>'plugin_key', a.before->>'plugin_key')
            else null
          end,
          a.action,
          concat(a.entity_type, ' ', a.action,
            case when a.entity_id is not null then ' · ' || a.entity_id::text else '' end),
          null,
          null,
          'recorded',
          null
        from public.audit_logs a
        left join public.organizations o on o.id = a.organization_id

        union all

        select
          'plugin-error:' || p.id::text,
          p.updated_at,
          'production',
          'error',
          'plugin-host',
          p.organization_id,
          o.name,
          p.plugin_key,
          'plugin.error',
          coalesce(nullif(p.last_error, ''), 'Plugin reported an error state'),
          null,
          null,
          'failed',
          'plugin_error'
        from public.plugins p
        join public.organizations o on o.id = p.organization_id
        where p.status = 'error'
      ) events
      where (p_organization_id is null or events.organization_id = p_organization_id)
        and (p_plugin_key is null or events.plugin_key = p_plugin_key)
      order by events.occurred_at desc
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x
  ), '[]'::jsonb);
end
$fn$;

revoke all on function public.developer_logs(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.developer_logs(uuid, text, integer) to authenticated;
