# 17 — Gap analysis: Mekholi vs global POS products

An audit of what Mekholi ships today against the feature sets of the leading
global POS products (Square, Shopify POS, Lightspeed Retail, Loyverse) and the
locally dominant Bangladesh systems (Retailers POS, Techno POS, Mediasoft,
PosMate BD, E-hishab). Run on **2026-09-27** at `d5c0eb7`. Every "have" below
was verified against the working tree, not the docs; every "missing" was
verified by grep before it was written down.

> **Historical baseline:** this document is preserved as the 27 September
> snapshot. Several gaps have since shipped. In particular, gap #25 was closed
> on 29 September with a manifest, install/maskable icons, generated versioned
> app-shell service worker, deep-link fallback, safe update lifecycle, and
> automated tests. Use `20-full-product-readiness-audit-2026-09-29.md` for the
> current readiness decision.

---

## 1. What Mekholi already has (the baseline)

Verified in `src/main.ts` route registrations, `src/features/*`, `src/plugins/*`
and the migrations:

| Area | Shipped |
|---|---|
| Selling | POS with search/cart/hold/resume, split payment, change due, quick cash sale, anonymous sales, invoice preview/print/image/PDF, returns (full/partial/item), refund to method or store credit |
| Catalogue | Products (quick add, full form, duplicate), categories/brands/units screens, product photos (ImgBB), variants, batch/expiry, serials, warranty, weight-scale barcodes |
| Inventory | Immutable stock ledger, weighted-average costing, stock in/out/adjust/transfer, low-stock alerts, reorder points, per-product history |
| Purchasing | Purchase orders → full/partial receive, supplier balances, supplier payments |
| Money | Register sessions (open/close/cash in-out/variance), expenses with categories, register session report |
| People | Customers with history, staff accounts, roles/RBAC, audit log with before/after |
| Analytics | 8-widget dashboard, measure×dimension analytics engine, 11+ reports, CSV/print/PDF export |
| Platform | Plugin SDK (9 plugins shipped), offline POS (IndexedDB + write queue + dedup replay), Android app, bn⇄en i18n, dark mode, command palette, keyboard shortcuts, device setup, loyalty with tiers |

That baseline already beats Loyverse on inventory rigor and beats every local
BD product on architecture (RLS multi-tenancy, plugin isolation, offline
replay proofs). The gaps below are what the competitors have and Mekholi does
not.

---

## 2. Tier 1 — Missing, and losing sales in the home market today

These are table stakes in the Bangladesh market: every serious local
competitor (Retailers POS, Techno POS, E-hishab, PosMate BD) ships them.

| # | Gap | Evidence / current state | Who has it |
|---|---|---|---|
| 1 | **Mobile-money integration (bKash / Nagad / Rocket)** — real integration: payment request, QR on the customer screen, trxID verification against the gateway. Today the cashier types a trxID into a free-text reference field (`payment-dialog.ts:69`) and nothing verifies it. | Manual reference only | PosMate BD, Retailers POS, POS Soft BD |
| 2 | **SMS receipts & alerts** — invoice by SMS to the customer, daily sales/profit summary SMS to the owner, due-payment reminder SMS. Zero SMS/notification code in `src/`. The `notifications` plugin is roadmap #14, unbuilt. | Absent | Sunshine, Techno POS, E-hishab |
| 3 | **NBR-compliant VAT invoicing (Mushak 6.3)** — BD VAT invoice format, VAT at percentage or fixed amount per line, VAT summary report for filing. There are tax profiles in seeds but no Mushak output. | Partial (tax fields, no compliance output) | PosMate BD, E-hishab |
| 4 | **Product CSV import/export** — the engine exists (`shared/export/csv.ts`, used by Reports) but products cannot be imported or exported. For a shop migrating from a competitor this is the difference between an afternoon and a week. Roadmap Phase 2 item, still open (P2-1). | Engine exists, no product UI | Square, Loyverse, Lightspeed, all local products |
| 5 | **Customer due / credit ledger ("baki khata")** — the single most-used feature of BD shop software: sell on credit, track per-customer due, collect partials, print a due statement. Store credit exists for refunds; a *receivables* ledger does not. | Absent | Every local competitor; it is the whole product of HishabPati/TaliKhata |
| 6 | **Barcode label printing** — generate and print price/barcode labels for products (roadmap plugin #11, unbuilt). Shops with unlabelled local goods cannot use scanning without it. | Absent | Square, Loyverse, Lightspeed, Techno POS |
| 7 | **Branch switcher** — the schema is multi-branch (`branches`, per-branch sessions) but no UI or RPC lets a user switch branches (`set_active_branch` was never built — P1-4). A shop with two branches cannot operate the second. | Schema-complete, workflow-absent | Lightspeed, Mediasoft, Shohoz |

---

## 3. Tier 2 — Core-POS parity gaps vs Square / Lightspeed / Loyverse

Already on the roadmap (Phase 7 capability plugins 7–14), none started:

| # | Gap | Notes |
|---|---|---|
| 8 | **Promotions / discount rules engine** | Manual line discounts exist in the cart. Automatic rules — happy hour, buy-X-get-Y, basket-total offers, scheduled sale prices — do not. Roadmap #8. |
| 9 | **Gift cards** | Sell a card, redeem across branches, balance inquiry. Roadmap #12. Square/Lightspeed ship it natively. |
| 10 | **Stocktake / cycle counting** | Walk the shelves, enter counts, post variances as COUNT movements. Explicitly deferred since Phase 3. Loyverse ships it free. |
| 11 | **Wholesale price lists / customer groups** | Tiered pricing per customer group; B2B pricing. Roadmap #7. |
| 12 | **Production / BOM (composite items)** | A bakery turning flour into bread; kitting/bundles. Roadmap #10. Loyverse composite items, Lightspeed kitting. |
| 13 | **Accounting integration** | Journal export to Tally / QuickBooks / Xero, or a built-in day-book. Roadmap #13. Techno POS has built-in accounting; Lightspeed integrates QuickBooks. |
| 14 | **Employee time clock & shift reports** | Clock in/out, hours per staff, sales per cashier per shift (cashier report exists; time tracking does not). Square ships this in the free tier. |
| 15 | **Quotations / estimates → invoice** | Furniture, electronics and hardware shops quote before selling. Absent. |
| 16 | **Layaway / instalment sales (kisti)** | Big in BD electronics and furniture retail: schedule, collect, track outstanding instalments. Lightspeed has layaway; local shops run it on paper. |
| 17 | **Purchase suggestions / auto-PO** | The reorder list report exists; one-tap "draft a PO from the reorder list" does not. Lightspeed auto-generates POs. |

---

## 4. Tier 3 — Omnichannel and growth features

Where the global products are a generation ahead:

| # | Gap | Notes |
|---|---|---|
| 18 | **E-commerce / online storefront sync** | Square Online and Shopify give every shop a web store sharing the POS catalogue and stock. Nothing in Mekholi sells online. |
| 19 | **Courier / delivery integration** | BD-specific: Pathao, RedX, Steadfast booking + tracking from the sale. E-hishab ships courier management. |
| 20 | **Marketing & campaigns** | Customer segmentation (RFM), bulk SMS/email campaigns to segments, win-back offers. Square Marketing / Lightspeed Advanced. |
| 21 | **AI insights & demand forecasting** | 2025-26 differentiator in Square ("operational insights"), Shopify (content/automation) and Shohoz (AI forecasting): predict stockouts, suggest order quantities, flag anomalies. Mekholi's analytics engine is descriptive only. |
| 22 | **Customer-facing display & self-checkout kiosk** | Second-screen order display with QR payment; Lightspeed ships kiosks. Relevant once mobile-money QR (gap #1) exists. |
| 23 | **Appointments / service jobs** | The Repair-shop bundle (roadmap Shape C) needs job cards, status, ready-notifications. Square Appointments is a whole product. |
| 24 | **Multi-currency** | Border shops and importers price in USD/INR. Single-currency today. |

---

## 5. Tier 4 — Platform and operational gaps

| # | Gap | Notes |
|---|---|---|
| 25 | **PWA installability — shipped 2026-09-29** | Manifest, install/maskable icons, generated versioned app-shell service worker, offline History API fallback, cache cleanup, explicit safe update activation, and tests now exist. Deployed cross-browser/device validation remains a release-gate task. |
| 26 | **Restaurant mode** | Tables, KOT/kitchen printing, order courses. Explicitly deferred (doc 08 §6) — noted here because every global comparison table has a restaurant column. |
| 27 | **Hardware breadth** | Receipt printers and barcode scanners are covered (plugins). Cash drawer kick, customer pole display, and weighing-scale *live* (serial/HID) integration are not — the weight-scale plugin reads printed labels, not the scale itself. |
| 28 | **Backup / data export for the owner** | Reports export CSV, but there is no "download all my data" (full org export). A trust feature every khata app advertises. |
| 29 | **In-app onboarding depth** | The wizard is two fields (name + type). Roadmap promised 7 steps incl. first product; competitors do guided setup with sample data. |

---

## 6. What Mekholi has that the comparison set does not

Worth stating, because a gap list reads like a deficit and this is not one:

- **A real plugin architecture** — capability plugins add tables, screens,
  reports and POS panels without touching `src/features/` (lint-enforced).
  None of Loyverse, or any BD product, has an equivalent; Square/Shopify have
  app stores but third-party apps cannot join the sale transaction the way
  `loyalty`'s sale adjustment does.
- **Provable offline** — replay without duplicates or negative stock is
  asserted by tests, not marketing. Shopify POS offline is famously limited.
- **An immutable stock ledger** with `before + delta = after` proven by
  property tests — stronger than anything in the comparison set's public docs.
- **Bangla-first i18n** with locale-aware digits — the global products treat
  Bangla as absent; local products treat English as absent.

---

## 7. Recommended build order

Weighing BD-market urgency × effort × reuse of what already exists:

1. **Customer due ledger (#5)** — mostly existing machinery (parties, payments,
   store-credit RPCs are precedents). Highest local demand per line of code.
2. **Product CSV import/export (#4)** — the engine exists; this is one screen
   and one RPC. Unblocks every migration from a competitor.
3. **SMS receipts + owner summary (#2)** — one Edge Function and a settings
   panel; the `notifications` plugin slot is already on the roadmap.
4. **PWA manifest + service worker (#25) — shipped 2026-09-29.** Next, validate
   install, update, storage-eviction and offline deep-link behavior on the
   deployed browser/device matrix.
5. **Branch switcher (#7)** — one RPC + one control; the schema is done.
6. **bKash/Nagad integration (#1)** — bigger (merchant onboarding, callbacks,
   an Edge Function per gateway), but it is the headline feature local buyers
   ask about first.
7. **Promotions engine (#8)**, then **stocktake (#10)**, then **gift cards
   (#9)** — in roadmap order, as plugins, which is what Phase 7 already says.

Everything in Tier 3 should wait until Tier 1 is closed: an online store for a
shop that cannot yet take bKash properly is the wrong order.
