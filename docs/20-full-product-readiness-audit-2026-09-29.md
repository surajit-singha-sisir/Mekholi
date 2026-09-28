# Mekholi full POS product-readiness audit

**Audit date:** 29 September 2026  
**Audited revision:** `312a34ae5feab9ecf0e2e0152dbe4f5ea62fe662` (`main`)  
**Markets assessed:** Bangladesh retail and international/general POS  
**Decision type:** product and engineering readiness assessment, not legal, tax, PCI, or accessibility certification

## 1. Executive verdict

Mekholi is a substantial, coherent POS product—not a prototype. Its sale, inventory, purchase, customer, supplier, expense, staff, role, reporting, audit, branch, offline, and extension foundations are real implementations backed by an unusually broad automated test suite. Server-side organization boundaries, permission checks, audited developer support, integer money, append-only business history, and atomic database RPCs are particularly strong foundations.

It is **ready for a controlled Bangladesh pilot** with selected merchants, supported hardware, manual/mobile-wallet payment recording, trained operators, and active engineering support. It is **not yet ready for an unsupported public Bangladesh launch** or for claims of complete Bangladesh regulatory compliance.

It is **not yet ready for a general global-market launch**. The architecture is internationally extensible, but the product, localization, payments, tax/compliance, operational controls, integrations, accessibility evidence, and support posture do not yet meet the expectations of a broadly marketed international SaaS POS.

### Readiness decisions

| Target | Decision | Confidence | Meaning |
|---|---|---:|---|
| Internal demonstrations | **Ready** | High | The build and major workflows are implemented and tested. |
| Bangladesh closed pilot | **Conditionally ready** | High | Use an explicit pilot runbook, supported hardware matrix, backups, monitoring, and fast support. Do not present the VAT feature as independently certified. |
| Bangladesh general availability | **No-go today** | High | Close the P0 launch controls in §8 first. |
| Single-country deployment outside Bangladesh | **No-go today** | Medium-high | Requires country-specific tax, receipts, payments, privacy terms, localization, and operational validation. |
| Broad global SaaS launch | **No-go today** | High | Requires substantially more product, compliance, integration, localization, and reliability work. |

Indicative scores are **Bangladesh closed-pilot readiness: 7/10**, **Bangladesh general-availability readiness: 5/10**, and **global general-availability readiness: 3/10**. These scores express launch risk, not code quality.

## 2. Evidence and limitations

### Evidence inspected

- Current source under `src/`, 15 shipped plugins, database migrations, generated API contract, CI workflow, Android source, and product documentation.
- `npm run check` at the audited revision: **83 test files, 1,051 tests, 222/222 behavioral database checks, migration assertions, typecheck/lint/architecture checks, and production build all passed**.
- Current database contract: **59 RPCs, 16 relations, 71 migrations**.
- Authenticated live verification previously performed against the deployed Supabase project, including developer support-session lifecycle and purchase-product discovery for an item with zero destination stock.
- Current dependency scan: `npm audit` reports **0 critical, 1 high, and 1 moderate** advisory. Both are in development tooling (`vite` directly and transitive `esbuild`), not identified as runtime browser dependencies; they still require remediation.
- Android source includes a native login/POS UI, session store, connectivity, outbox, scheduler, transport, synchronization core, and core tests.

### Evidence levels used in this report

1. **Implemented and automatically verified** — current executable source plus tests/checks.
2. **Implemented but only partially validated** — current source, without sufficient real-device, end-to-end, legal, or operational evidence.
3. **Documented/architected** — design exists, but documentation alone is not treated as shipped capability.
4. **Not evidenced** — no adequate current implementation or production proof found.

### Important limitations

- `npm run e2e` could not run because the script requires `.env`, which is not present. `.env.db` exists for database checks but is not accepted by this HTTP test. This is a release-evidence gap, not evidence that the workflow fails.
- No independent penetration test, tax/legal opinion, accessibility audit, load test, disaster-recovery restore drill, or multi-week merchant pilot evidence was available.
- Automated DOM tests do not prove printer, scanner, cash drawer, scale, low-cost Android device, Safari/iOS, intermittent mobile network, or long-shift stability.
- The report assesses the repository and available live checks, not every Supabase/GitHub/ImgBB tenant setting or external vendor SLA.
- Bangladesh tax thresholds and prescribed forms can change. `docs/18-bangladesh-vat.md` and the in-product guide require professional validation before a compliance claim.

## 3. What is genuinely implemented

### Core retail operations

Implemented surfaces include dashboard, POS, sales history/invoices, customer management, product catalogue and variants, stock/history/transfer/adjustment, suppliers, purchasing, expenses, reports/exports, register, users, roles, permissions, plugins, audit trail, and settings.

The selling path supports cart persistence, line and order discounts, customer attachment/creation, fractional quantities, generic configurable tenders, split payment, payment references, change/settlement, due sales, receipt/invoice rendering, held sales, and offline write queuing. Sales and inventory mutation use server-side RPCs rather than a chain of browser writes.

Product operations include categories, brands, units, tax, image support, variants, barcode-oriented workflows, and UTF-8/Excel-friendly product CSV import/export. Purchase search is independent of existing destination stock, so a never-before-stocked item can correctly enter a warehouse through purchasing.

### Bangladesh-relevant capabilities

- BDT and integer-minor-unit money handling.
- English and Bangla locale infrastructure, including Bangla shell/navigation/settings coverage.
- Configurable bKash/Nagad-style payment method recording and transaction references, without a hardcoded country-specific payment model.
- Customer due ledger/khata workflow.
- Bangladesh VAT plugin with Mushak-6.3 receipt presentation, BIN, and VAT line.
- Product CSV import/export, barcode/label printing, branch support, supplier wallet numbers, and low-stock/notification capability.
- Batch/expiry, warranty, serial-number, weight-scale, printer-setup, loyalty, and multi-currency plugins.

These are implemented features. They should not be confused with certified gateway integrations, NBR approval, fiscal-device certification, or full Bangla workflow translation.

### Architecture and security foundations

- Organization-scoped data model and row-level access patterns.
- Server-side permission checks for privileged RPCs; client navigation is not the authority.
- Auditable developer control plane and short-lived, shop-scoped support sessions that retain the real actor identity.
- Safe user revocation while preserving historical foreign-key/audit integrity.
- Plugin manifests, permission namespacing, compatibility checks, dependency/conflict handling, lazy loading, and organization-specific enablement.
- Integer money/domain types and explicit quantity precision.
- Offline IndexedDB/outbox design with idempotency concepts and an Android synchronization core.
- Auth callback credential stripping and no service-role credential in browser source.
- CI gates for typecheck, lint, architecture boundaries, unit behavior, API contract, database behavior, Android core, migrations, and build.

## 4. Bangladesh-market assessment

### Strengths

1. **The operational centre is credible.** Selling, purchasing, inventory, suppliers, expenses, staff permissions, auditing, reports, and customer dues form a usable small-retail system.
2. **Local retail realities are represented.** BDT, Bangla shell, khata, fractional quantities, mobile-wallet references, labels/barcodes, branches, expiry, warranty, and serials are materially relevant.
3. **The database boundary is stronger than many early POS products.** Critical state transitions are centralized and permission checked, reducing overselling, tenant leakage, and partial-write risk.
4. **Weak or interrupted connectivity has been designed for.** Browser queueing and native Android synchronization are meaningful advantages, although field proof is still needed.
5. **The extension model supports verticalization.** Grocery, pharmacy-like expiry handling, electronics serial/warranty, and weighted goods can be assembled without contaminating the core.

### Bangladesh launch blockers and high risks

| Severity | Finding | Why it matters | Required evidence/action |
|---|---|---|---|
| **P0** | No demonstrated production backup/restore and disaster-recovery drill | A hosted database backup is not a recovery plan until a restore is timed and reconciled. Retailers cannot lose sales, dues, stock, or audit history. | Define RPO/RTO, enable suitable Supabase backup/PITR, perform a restore into isolation, reconcile totals and identities, document owners and escalation. |
| **P0** | No complete production observability/on-call evidence | Console errors and CI do not detect a failing till, queue backlog, RPC error spike, database saturation, or plugin failure in production. | Add error capture, structured correlation IDs, queue-age/failure metrics, RPC/database alerts, synthetic sale checks, dashboards, paging, and an incident runbook. |
| **P0** | Tax output is implemented but not independently validated | Mushak-6.3 naming/BIN/VAT display is valuable, but correctness depends on product tax configuration and current law. Device-local invoice design can also differ across tills. | Obtain Bangladesh VAT practitioner/legal review; test prescribed samples; define tax-rate governance and change control; enforce/report receipt-template consistency across devices. |
| **P0** | Privacy, contractual, retention, and merchant data-control package is incomplete | A commercial launch needs enforceable terms, privacy notice, processor/subprocessor position, support-access policy, retention, deletion, and breach handling. | Publish reviewed Terms, Privacy Policy, DPA where applicable, subprocessors, retention schedule, DSAR/deletion workflow, breach plan, and support-access policy. |
| **P0** | No release-level real-hardware and full authenticated E2E matrix | Unit/database tests cannot prove cash-counter behavior. The HTTP E2E script did not run in this audit because `.env` was absent. | Make credential-safe staging E2E a CI/release gate; validate complete sale/refund/due/purchase/stock paths on supported printer/scanner/scale/Android/browser/network combinations. |
| **P1** | bKash/Nagad/card are recorded, not integrated/verified | Manual references do not confirm settlement, prevent duplicate transaction IDs, reconcile gateway payouts, or manage reversals. | Clearly label manual tenders; add duplicate-reference controls and reconciliation, or integrate approved providers through a secure server component and complete their certification. |
| **P1** | Bangla coverage is partial | Most feature screens remain English; shell/navigation/settings translation does not make the full cashier and back-office workflow Bangla. | Translate POS, products, stock, purchases, dues, reports, errors, receipts, and help; test Bangla typography, search, keyboard/input, wrapping, and operator comprehension. |
| **P1** | Browser app is offline-capable but not a complete installable PWA | No standard web manifest/service worker shell was found. A cold/reloaded browser still depends on the network and cannot provide a normal install experience. | Add manifest, icons, service-worker/app-shell strategy, update safety, cache-version recovery, and install/offline tests. |
| **P1** | Merchant-controlled full data export and lifecycle controls are incomplete | Report/product CSVs are not an owner-readable, complete organization export or portable backup. | Implement complete export with schema/version metadata; add documented account closure, retention, and deletion/anonymization workflow. |
| **P1** | Refund/return/exchange and cash-control depth needs release validation | These are fraud-sensitive, legally visible, and central to real retail. Existing sale controls must be proved as complete operator workflows and accounting outcomes. | Scenario-test permissions, reason codes, original tender, partial return, exchange, offline conflict, register reconciliation, audit history, and receipt output. |
| **P1** | Security hardening evidence is incomplete | Static GitHub Pages gives limited control over response security headers; no independent test or pen test is recorded. | Put production behind a host/CDN with CSP and modern security headers, dependency updates, secret scanning, rate/abuse tests, RLS review, support-session review, and an external pen test. |
| **P2** | Accessibility is not evidenced to a target standard | Basic ARIA/focus code exists, but there is no WCAG audit, keyboard matrix, screen-reader test, zoom/reflow test, or contrast report. | Target WCAG 2.2 AA; automate axe checks and perform keyboard, NVDA/VoiceOver, 200–400% zoom, touch-target, and color/contrast testing. |
| **P2** | Native Android client is materially smaller than the web product | Native login/POS/sync exists, but parity, release signing, update, device compatibility, crash reporting, and production distribution are not evidenced. | Define supported use case and parity boundary; add release pipeline, signed artifacts, store/MDM policy, compatibility matrix, telemetry, and field soak tests. |

### Bangladesh verdict

For a **closed pilot**, choose merchants whose workflow matches what exists: ordinary retail sales, manually recorded tenders, straightforward stock and purchases, supported receipt printers/scanners, and supervised VAT configuration. Start with one or a few branches, retain daily reconciliation, and guarantee rapid support.

For **general availability**, P0 items are mandatory. The strongest near-term positioning is “Bangladesh-first retail operations with khata, VAT-aware receipts, offline resilience, and optional vertical plugins”—not “certified tax/payment platform” and not “works with all hardware.”

## 5. Global-market assessment

### Foundations that travel well

- Currency and formatting abstractions, configurable tenders, and multi-currency support.
- Organization/branch/warehouse/register separation.
- Permissions, audit history, immutable actor identity, and controlled support access.
- Plugin architecture suitable for country and vertical modules.
- Offline-first concepts and a native Android synchronization core.
- Integer money and explicit quantity precision.
- CSV/report export and adaptable invoice design.

These reduce future rework. They do not by themselves create market readiness.

### Global gaps

| Severity | Gap | Global impact |
|---|---|---|
| **P0** | Country-specific tax/fiscalization/e-invoicing is absent beyond the Bangladesh module | VAT/GST/sales-tax rules, fiscal devices, invoice numbering, SAF-T/e-invoice mandates, rounding, refunds, and retention vary by jurisdiction. Each launch country needs an owned compliance pack. |
| **P0** | Integrated/acquiring payments and PCI scope are undefined | Generic/manual tenders are useful but not equivalent to card-present, wallet, terminal, tokenization, chargeback, settlement, and refund integrations. A global launch needs a deliberate PCI-minimizing architecture and certified partners. |
| **P0** | Privacy/data-residency/commercial terms are not country-ready | GDPR/UK GDPR and other regimes introduce lawful basis, processor contracts, DSARs, deletion, transfers, breach duties, cookies/telemetry choices, and sometimes residency expectations. |
| **P0** | Production SRE, DR, support SLA, status communication, and incident process are not evidenced | International merchants need predictable recovery, regional support hours, and transparent incidents. |
| **P1** | Only English and partial Bangla are available | Global readiness requires complete UI/receipt/help/error translation, locale fallback, pluralization, address/phone/name variation, RTL validation, and locale QA. |
| **P1** | International money/tax edge cases need deeper proof | Cash rounding, zero/three-decimal currencies, tax inclusive/exclusive mixes, compound taxes, tips/service charges, fiscal rounding, refunds, and exchange-rate accounting vary. |
| **P1** | Key mature-POS modules are absent or not evidenced | Promotions/coupons, gift cards/store credit, formal stocktake/cycle counts, quotations/orders/layaway, wholesale/customer-group pricing, purchase suggestions/automatic reordering, BOM/recipes, time clock/payroll links, delivery/e-commerce, and accounting integrations are common selection criteria. |
| **P1** | Hardware ecosystem is not productized | A global product needs country-specific certified devices, USB/Bluetooth/network paths, drawers, customer displays, terminal integration, OS/browser compatibility, drivers, and support boundaries. |
| **P1** | Installable web deployment is incomplete | The lack of a standard PWA manifest/service worker reduces resilience and mobile/tablet adoption. |
| **P1** | Marketplace/plugin governance is architectural, not an operating ecosystem | Third-party code requires signing/review, sandboxing or strong capability boundaries, version/deprecation policy, security response, billing, publisher terms, and support ownership. Current shipped plugins are first-party bundles. |
| **P2** | Enterprise administration is incomplete | Larger customers commonly require SSO/SAML/OIDC governance, SCIM, IP/session policy, regional tenancy, consolidated multi-entity controls, export APIs/webhooks, and advanced audit retention. |
| **P2** | Accessibility conformity is unproven | Public-sector and larger buyers may demand formal WCAG/EN 301 549/Section 508 evidence. |

### Global verdict

Do not attempt a simultaneous “global” launch. Select **one next country and one retail vertical**, then build a country pack containing tax/fiscal requirements, payments, legal/privacy terms, receipt/invoice formats, language/locale, hardware, support hours, and local integration partners. Repeat only after the first country has production evidence.

Mekholi can become a global platform because its core boundaries are sound. Today it is an internationally extensible Bangladesh-first product, not a globally operational product.

## 6. Engineering and quality assessment

### Strong findings

- The current full check passes across 1,051 tests and 222 behavioral database checks.
- Database migrations and the generated API contract are actively validated.
- Architecture-boundary and plugin tests reduce accidental coupling.
- Privileged flows are designed around server authorization and audit identity.
- Money/quantity models avoid floating-point financial mutation.
- Plugin failure isolation, compatibility, and per-shop activation are tested.
- Offline queues and idempotency are treated as domain concerns rather than UI decoration.
- The production bundle uses plugin/code splitting, although the primary application JavaScript remains substantial (approximately 534 KB uncompressed for the largest generated application chunk observed in `dist`).

### Engineering risks

1. **Dependency advisories:** update Vite/esbuild to non-vulnerable compatible versions and keep `npm audit` at release thresholds. The observed advisories primarily concern development-server/build-tool behavior, so they are not evidence of a deployed browser exploit, but they remain unacceptable technical debt for a release pipeline.
2. **No successful release E2E in this audit:** convert the HTTP E2E check from optional local evidence into a staging CI gate with protected credentials and redacted artifacts.
3. **Coverage is broad but not equivalent to scenario certification:** add high-value full-stack tests for sale, due collection, return/refund, offline replay/conflict, purchase receive, transfer, stockout, branch switch, role denial, and support session.
4. **Performance budgets are absent:** establish cold-load, time-to-POS, product-search latency, checkout latency, offline startup, memory, and bundle budgets on low-end Android hardware and poor networks.
5. **Schema/tenant security needs independent review:** database tests are strong; add adversarial tests and an external RLS/RPC/authorization review.
6. **Device-local settings can create compliance variance:** printer and invoice design legitimately vary by device, but compliance-critical identity/template values need shop policy, visibility, and drift alerts.

## 7. Capability truth table

| Capability | Current state | Readiness interpretation |
|---|---|---|
| POS sale and split tender | Implemented/tested | Pilot-ready; hardware/full-stack validation required |
| Inventory and stock history | Implemented/tested | Strong foundation |
| Purchasing and receiving | Implemented/tested | Strong; latest branch-independent picker fix live |
| Customers and khata/dues | Implemented/tested | Locally relevant; reconciliation scenarios needed |
| Suppliers and expenses | Implemented/tested | Useful SMB coverage |
| Staff/roles/permissions/audit | Implemented/tested | Strong, subject to independent security review |
| Branch/warehouse/register | Implemented | Requires multi-branch field validation |
| Product CSV migration | Implemented/tested | Meaningful onboarding capability |
| Reports/CSV/print | Implemented/tested | Not a complete owner data export/accounting integration |
| Mushak-6.3 output | Implemented/tested at code level | Not legal certification; requires professional validation and configuration controls |
| bKash/Nagad/card processing | Manual tender/reference recording | Not gateway processing or automated settlement |
| Bangla localization | Partial | Shell/settings ready; product workflows are not fully localized |
| Browser offline behavior | Implemented architecture/tests | Needs field soak, conflict, quota, and cold-start validation |
| Installable PWA | Not evidenced | Launch gap |
| Native Android POS | Implemented subset/core tests | Needs productization and release evidence |
| Barcode/labels/printer setup | Implemented plugins | Needs supported-device matrix |
| Scale, serial, warranty, expiry | Implemented plugins | Vertical value; hardware/field validation varies |
| Multi-currency | Implemented plugin | Does not complete country tax/accounting requirements |
| Promotions/gift cards/stocktake | Not adequately implemented/evidenced | Competitive gap |
| Accounting/e-commerce/delivery integrations | Not evidenced | Competitive and operational gap |
| Production monitoring/DR/legal pack | Not evidenced as complete | General-availability blocker |

## 8. Prioritized launch plan

### P0 — before Bangladesh general availability

1. **Production reliability package:** monitoring, structured errors, queue/RPC/database alerts, on-call ownership, status communication, and incident runbooks.
2. **Backup and restore:** explicit RPO/RTO, configured backups/PITR as appropriate, restore drill, reconciliation script/checklist, and evidence retention.
3. **Release E2E and hardware certification:** staging CI test, supported browser/Android/printer/scanner/scale matrix, poor-network/offline replay, long-shift soak, and rollback rehearsal.
4. **Bangladesh VAT review:** professional review of forms, fields, numbering, tax calculations, returns/register implications, retention, and configuration governance. Correct the product/docs after review.
5. **Legal/privacy/data package:** Terms, Privacy Policy, processor/subprocessor disclosures, retention, DSAR/export/deletion, breach response, support access, acceptable use, and merchant responsibilities.
6. **Security release review:** remediate dependency advisories, add CSP/security headers on a production-capable host, secret/dependency scanning, abuse/rate-limit review, external RLS/RPC assessment, and penetration test.
7. **Financial control scenarios:** prove return/refund/exchange, voids, till open/close, tender variance, due collection, offline duplicates, branch transfer, and audit reconstruction end to end.

### P1 — pilot-to-scale improvements

1. Finish Bangla translation for cashier and core back-office workflows.
2. Add standard PWA installability and app-shell/update recovery.
3. Provide complete merchant data export and closure workflow.
4. Decide payment strategy: clearly manual with reconciliation, or certified integrations.
5. Productize hardware support with exact model/OS/browser requirements.
6. Add performance budgets and low-end Android/network benchmarks.
7. Add stocktake/cycle count, promotions/coupons, gift cards/store credit, and stronger cash-management controls according to merchant discovery.
8. Establish merchant onboarding, training, in-product help, migration service, support SLAs, and release/change communications.

### P2 — targeted expansion

1. Choose one country/vertical and deliver a complete country pack.
2. Add accounting export/integration, e-commerce/order/delivery integration, public API/webhooks, and partner governance.
3. Add enterprise identity/lifecycle capabilities only when the target segment requires them.
4. Conduct formal accessibility conformance work.
5. Build marketplace security, review, signing, billing, deprecation, and publisher operations before accepting third-party plugins.

## 9. Pilot acceptance gate

A Bangladesh pilot should start only when all of the following are named and evidenced:

- merchant, branches, SKU/transaction scale, tax status, and supported workflows;
- exact devices, printers, scanners, scales, browsers/Android versions, and network assumptions;
- daily backup and reconciliation owner;
- monitoring and support contact with response targets;
- tested restore/rollback and offline-queue recovery procedure;
- opening inventory and product import validation;
- staff roles and least-privilege review;
- sample receipt/VAT review by the merchant's qualified adviser;
- day-end cash/tender/due reconciliation process;
- defect/severity policy and safe deployment window;
- explicit list of unsupported capabilities, including the distinction between manually recorded and integrated payments.

Run the pilot for enough time to cover returns, supplier receiving, stock adjustments, month-end reporting, connectivity loss, staff changes, and at least one application update—not only happy-path sales.

## 10. Final conclusion

Mekholi's **engineering core is ahead of its operational product maturity**. That is a favorable problem: the system already has defensible domain, authorization, audit, offline, database, and plugin boundaries. The missing work is mostly the difficult work that turns good software into a trustworthy commercial service—field proof, compliance ownership, security validation, recovery, monitoring, hardware support, legal terms, complete localization, integrations, and support operations.

The correct decision is:

- **Proceed with a tightly controlled Bangladesh pilot after a short pilot-readiness gate.**
- **Do not announce Bangladesh general availability until all P0 controls are closed with evidence.**
- **Do not market the product as globally ready. Choose one country and vertical at a time.**

Passing 1,051 tests is strong evidence of implementation quality. It is not a substitute for a restore drill, a tax opinion, a penetration test, real hardware, real operators, or production incident readiness. Closing those evidence gaps—not merely adding more screens—is the shortest path from Mekholi's strong foundation to a launchable POS business.
