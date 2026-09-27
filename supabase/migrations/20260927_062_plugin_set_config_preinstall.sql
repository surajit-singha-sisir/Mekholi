-- 062 — plugin_set_config accepts a config before the plugin is installed.
--
-- The paid-plugin flow writes the licence into the plugin's config *when
-- the shopkeeper subscribes*, which is naturally a moment before
-- `plugin_enable` has ever run for that shop — there is no `plugins` row
-- yet, and the old function answered `plugin_not_installed`, a 400 the
-- client had to catch and paper over with tab-local memory. A refresh at
-- the wrong moment and the trial the shopkeeper just started was gone.
--
-- The function was defending the wrong thing. What must be refused is a
-- config for a plugin this server has never heard of — a typo, or a probe.
-- A config for a *known package* the shop simply has not switched on yet
-- is a legitimate thing to hold: that is exactly what an entitlement is.
--
-- So: when the row is missing but the package exists, create the row
-- dormant — enabled=false, the shipped version, the offered config. It is
-- the same row `plugin_enable` would have upserted, minus the enabling;
-- and 040's enable deliberately preserves an existing row's config when
-- its own p_config is the default '{}', so the licence recorded here
-- survives the switch-on that follows. A key that matches no package
-- still raises, now under the same name plugin_enable uses: unknown_plugin.

create or replace function public.plugin_set_config(
  p_organization_id uuid,
  p_plugin_key text,
  p_config jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row record;
  v_shipped text;
begin
  perform app.require_org(p_organization_id);
  perform app.require_permission('plugins.manage');

  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'plugin_config_invalid: expected an object' using errcode = 'P0001';
  end if;

  if pg_column_size(p_config) > 32768 then
    raise exception 'plugin_config_invalid: larger than 32 KB' using errcode = 'P0001';
  end if;

  update public.plugins
     set config = p_config
   where organization_id = p_organization_id
     and plugin_key = p_plugin_key
  returning * into v_row;

  if not found then
    v_shipped := app.plugin_package_version(p_plugin_key);
    if v_shipped is null then
      raise exception 'unknown_plugin: %', p_plugin_key using errcode = 'P0001';
    end if;

    insert into public.plugins
          (organization_id, plugin_key, version, enabled, config, status)
    values (p_organization_id, p_plugin_key, v_shipped, false, p_config, 'ok')
    on conflict (organization_id, plugin_key) do update
       set config = excluded.config
    returning * into v_row;
  end if;

  insert into public.outbox
        (organization_id, event_type, aggregate_type, aggregate_id, payload)
  values (p_organization_id, 'plugin.configured', 'plugin', v_row.id,
          jsonb_build_object('plugin_key', p_plugin_key));

  return jsonb_build_object('plugin_key', p_plugin_key, 'config', v_row.config);
end
$fn$;

-- CREATE OR REPLACE keeps the existing grants (authenticated may execute,
-- anon may not), but saying so costs nothing and protects against a future
-- migration recreating the function from scratch.
revoke all on function public.plugin_set_config(uuid, text, jsonb) from public, anon;
grant execute on function public.plugin_set_config(uuid, text, jsonb) to authenticated;
