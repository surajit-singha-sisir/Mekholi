-- 061 — Multi-Currency Display, seeded as a package.
--
-- A shop keeps its books in one currency and reads them in another:
-- ৳1,400 on the ledger, $11.43 on the screen, at a rate the shop either
-- takes live from the exchange-rate feed or types in itself.
--
-- ── Why this package ships no SQL ────────────────────────────────────────
-- The conversion is a *display* conversion, by design. Every monetary
-- column in this database is, and remains, the shop's base currency in
-- numeric(14,2); the plugin pushes a formatter provider into the client's
-- money module and never writes an amount anywhere. Rewriting stored
-- amounts at a market rate would make history lie — a sale worth ৳1,400
-- on the day it happened is worth ৳1,400 forever, whatever the dollar did
-- since. So there are no tables, no functions, and nothing here to apply
-- per-organization: the shop's chosen target currency, rate mode, manual
-- rate and cached rate table all live in the plugin's org-scoped config
-- bag (`plugins.config`), which already syncs across the shop's devices
-- and survives disable/enable.
--
-- The row exists so the Plugins screen can list, price and switch it like
-- every other plugin. Paid: unlike printer-setup, this is not describing
-- hardware the shop already owns — it is a capability, priced like one.

insert into public.plugin_packages
      (plugin_key, name, category, version, core_api_version, description,
       dependencies, conflicts)
values
  ('multi-currency', 'Multi-Currency Display', 'optional', '1.0.0', '^1.0.0',
   'Read every amount in a second currency — live exchange rate when online, cached when not, your own rate when you know better. The books stay in the shop''s base currency.',
   '{}', '{}')
on conflict (plugin_key) do update
   set name = excluded.name,
       category = excluded.category,
       version = excluded.version,
       core_api_version = excluded.core_api_version,
       description = excluded.description,
       dependencies = excluded.dependencies,
       conflicts = excluded.conflicts;
