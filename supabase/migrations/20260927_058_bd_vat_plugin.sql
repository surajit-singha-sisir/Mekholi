-- 058 — Bangladesh VAT (Mushak), packaged.
--
-- The Mushak-6.3 rendering shipped in core with 7e90316, on the argument
-- that a saved tax document must keep printing whatever plugins do. What
-- was wrong with that shape is the doorway: the option sat in printer-setup
-- for every shop in every country, next to nothing that explained it.
--
-- The bd-vat plugin is that doorway done properly — the Mushak switch, the
-- BIN, and the মূসক guide (docs/18) live together, and only a shop that
-- enabled the plugin sees any of it. Like the hardware plugins (056) it
-- owns no table and ships no SQL: everything it writes is the per-device
-- invoice design. Free, category 'industry', because it is a country pack,
-- not a capability — charging for tax compliance is charging a shop for
-- obeying the law.

insert into public.plugin_packages
      (plugin_key, name, category, version, core_api_version, description,
       dependencies, conflicts)
values
  ('bd-vat', 'Bangladesh VAT (Mushak)', 'industry', '1.0.0', '^1.0.0',
   'The NBR Mushak-6.3 tax invoice: BIN, the VAT line on every sale, and a plain-words guide to the মূসক system.',
   '{}', '{}')
on conflict (plugin_key) do update
   set name = excluded.name,
       category = excluded.category,
       version = excluded.version,
       core_api_version = excluded.core_api_version,
       description = excluded.description,
       dependencies = excluded.dependencies,
       conflicts = excluded.conflicts;
