# Mekholi POS — Enterprise Launch Readiness Audit

**Audit date:** 3 October 2026
**Audited revision:** `0656d79` (`main`)
**Auditor scope:** engineering, security, data, reliability, operations, compliance posture
**Audit type:** enterprise launch-readiness assessment — *not* a certification (no pen test, tax opinion, WCAG conformance review, or SOC 2 / ISO 27001 attestation was performed)
**Supersedes/extends:** `docs/20-full-product-readiness-audit-2026-09-29.md` (product readiness). This report re-verifies that audit's open items and adds the enterprise-specific dimensions it did not cover.

---

## 1. Executive verdict

> **Mekholi is an unusually well-engineered POS core wrapped in a hobby-grade operating envelope.**

The domain model, database authorization design, and automated engineering gates are genuinely strong — stronger than most commercial POS products at a comparable stage. Every finding below is about what surrounds the code: identity lifecycle, observability, recovery, release control, privacy, and the evidence an enterprise buyer will demand.

**The gap is not quality. It is provability and operability.**

### Launch decision by tier

| Launch tier | Decision | Confidence | Gating condition |
|---|---|---:|---|
| Internal / demo | ✅ **Go** | High | None |
| Single-merchant supervised pilot (BD) | ✅ **Go** | High | Close P0-1 (password recovery) + P0-3 (backup drill) first |
| Multi-merchant public SMB launch (BD) | ⚠️ **Conditional** | Medium-high | All 7 **P0** items closed with evidence |
| **Enterprise / multi-outlet contract** | ❌ **No-go** | High | All P0 + P1 closed; external pen test; SSO; SLA; DPA |
| Regulated / public-sector buyer | ❌ **No-go** | High | Above + WCAG 2.2 AA conformance + SOC 2 Type I |

### Readiness scorecard

| # | Domain | Score | State |
|---|---|---:|---|
| 1 | Architecture & code quality | **9 / 10** | Excellent — boundary-enforced, no `any`, plugin isolation proven |
| 2 | Database design & data integrity | **8.5 / 10** | Excellent — `numeric(14,2)` money, row locks, append-only history |
| 3 | Multi-tenancy & authorization *design* | **8 / 10** | Strong design… |
| 4 | Multi-tenancy & authorization *proof* | **3 / 10** | …with **zero executing tests**. See F-02 |
| 5 | Identity & access management | **3.5 / 10** | No password recovery, no MFA, no idle lock |
| 6 | Application/edge security | **3 / 10** | No CSP possible on current host; no SRI; 7 dep advisories |
| 7 | Observability & on-call | **1.5 / 10** | Telemetry table exists and is **never written to** |
| 8 | Release engineering & change mgmt | **3.5 / 10** | Deploy not gated on CI; DB migrations applied by hand |
| 9 | Resilience & disaster recovery | **1 / 10** | No RPO/RTO, no restore drill, no runbook |
| 10 | Performance & scale | **4 / 10** | No budgets, no load test; 225 KB gz critical JS |
| 11 | Data governance & privacy | **1.5 / 10** | No export, no deletion, no retention, no DPA |
| 12 | Localization & accessibility | **3 / 10** | ~14 % of UI strings localizable; no a11y evidence |
| 13 | Test & QA assurance | **7 / 10** | 1 145 tests — but the riskiest modules are untested |
| 14 | Enterprise administration | **1 / 10** | No SSO/SCIM/API/webhooks/SLA/audit export |

**Composite enterprise readiness: 4.2 / 10.**
Weighted toward what enterprise procurement actually scores (security, availability, recoverability, governance), this is a *pre-contract* posture.

---

## 2. Method and evidence base

All findings are derived from the working tree at `0656d79`, executed locally on 3 Oct 2026.

### Verified by execution

| Check | Result |
|---|---|
| `npm run check` (full gate) | ✅ Pass |
| `npm run test` | ✅ **1 145 tests / 94 files**, 0 failures, 91 s |
| `npm run validate:migrations` | ✅ **222 / 222** behavioral checks, 74 migrations |
| `npm run typecheck` / `lint` / `check:boundaries` | ✅ Pass (297 files boundary-checked) |
| `npm run build` | ✅ 5.7 s → 1.5 MB `dist` (38 JS chunks) |
| `npm audit` | ⚠️ **7 advisories: 6 high, 1 moderate** |
| `npm run e2e` | ❌ **Not run** — needs `.env.db`; not in CI |
| `npm run contract:check` | ❌ **Not run** — requires a live database |

### Codebase scale

| Metric | Value |
|---|---|
| TypeScript source | 299 files · 78 731 lines |
| SQL migrations | 74 files · 20 825 lines |
| Database surface | 62 tables · 60 public RPCs · 16 relations |
| Shipped plugins | 15 |
| Test files | 94 (1 145 assertions) |
| Git history | 216 commits, single `main` branch |

### Explicitly NOT evidenced

External penetration test · load/soak test · DR restore drill · WCAG audit · VAT/legal opinion · real-hardware matrix (printer/scanner/scale/drawer) · iOS Safari validation · multi-week field pilot · Supabase project configuration (dashboard settings were not inspectable from the repo).

---

## 3. What is genuinely strong

These are load-bearing strengths. Preserve them — several findings below must be fixed *without* weakening them.

**S-1 · Database is the authorization boundary, not the UI.**
All 62 tables have RLS enabled (verified by parsing every migration, including the `DO`-loop in `015_rls.sql`). 49 also carry `FORCE ROW LEVEL SECURITY`. Financial tables (`sales`, `sale_items`, `sale_payments`, `stock_movements`, `register_sessions`, `expenses`, `purchases`…) have **SELECT-only** policies — the browser physically cannot forge a sale, only call a `SECURITY DEFINER` RPC that validates first.

**S-2 · Every `SECURITY DEFINER` function pins `search_path`.**
Checked all 13; zero exceptions. This closes the classic Postgres privilege-escalation vector. Internal primitives (`apply_stock_movement`, `next_sequence`, `app.require_permission`) are deliberately **not** granted to `authenticated` (`018_grants.sql:60-71`), with assertions enforcing it.

**S-3 · Money and concurrency are modelled correctly.**
125 monetary columns are `numeric(14,2)`; **no `float`/`double precision` anywhere in the schema**. `next_sequence` uses `UPDATE … RETURNING` for its row lock (`011_platform.sql:102`); stock uses `SELECT … FOR UPDATE` before mutation (`012_rpc_sale.sql:121`). Invoice numbering and oversell protection are concurrency-safe by construction.

**S-4 · Offline writes are idempotent by design.**
`sales` carries `UNIQUE (organization_id, client_ref)`; the outbox mints the ref once with `crypto.randomUUID()` and **never regenerates it on retry** (`offline/queue.ts:113-117`). A replayed sale returns the original receipt instead of double-charging. This is the single hardest thing to get right in offline POS, and it is right.

**S-5 · CI is a real gate.**
Typecheck (strict, no `any`), lint, architecture boundaries, 1 145 unit tests, API-contract conformance for both clients, Android/JVM core tests, full migration replay against real Postgres (PGlite/WASM) with 222 behavioral assertions, and a production build — on every PR and push.

**S-6 · Support access is designed for audit.**
`platform_support_sessions` requires a `reason`, optional `ticket`, an `access_mode` of `read_only|full`, a hard `expires_at` with a `CHECK (expires_at > started_at)`, and retains the real operator identity. This is better than most vendors ship.

**S-7 · Service worker is correctly versioned and scoped.**
`dist/sw.js` precaches a content-hashed shell, deletes superseded caches on `activate`, serves same-origin only, falls back to the app shell for History API deep links, and supports `SKIP_WAITING`. Safe update lifecycle.

**S-8 · Cross-tenant password hijack is explicitly prevented.**
`create_staff_account` links an existing `auth.users` row but **never re-passwords it** (`064_admin_creates_staff.sql:136`). The obvious attack was anticipated.

---

## 4. Findings register

Severity: **P0** = blocks public launch · **P1** = blocks enterprise contract · **P2** = blocks scale/procurement · **P3** = hygiene.

### P0 — Launch blockers

---

#### F-01 · P0 · No password recovery. Any user who forgets their password is permanently locked out.

**Evidence** — `supabase.auth.resetPasswordForEmail` and `auth.updateUser` appear **nowhere** in `src/`. `src/features/auth/login-view.ts` offers exactly three paths: sign-in (l.74), sign-up (l.140), Google OAuth (l.256). No "Forgot password" affordance exists.

**Impact** — A shop owner who forgets their password loses their business: dues ledger, stock, sales history, VAT records. Recovery requires manual Supabase dashboard intervention by you, for every incident, forever. For staff accounts created via `create_staff_account` (where the *admin* chose the password), this is near-certain within weeks of launch.

**Fix** — Add `resetPasswordForEmail` + a `/reset-password` route handling the `type=recovery` callback; add `updateUser({password})` for the change-password case; ensure the recovery redirect URL is in the Supabase allowlist. Add an admin-side "reset staff password" RPC so an owner can unlock a cashier without contacting you.

**Effort** — 1–2 days. **This is the single highest return-on-effort item in this report.**

---

#### F-02 · P0 · Tenant isolation is never tested by execution. The 222 "behavioral checks" cannot prove RLS.

**Evidence** — `tools/validate-migrations.mjs:890` states it plainly: *"PGlite runs as superuser, so GRANT/REVOKE are never enforced at runtime."* The suite verifies authorization **statically**, via `has_table_privilege()` / `has_function_privilege()` catalog inspection. It never executes a query as the `authenticated` role. The role is created `NOLOGIN` purely so grants resolve (l.56).

Consequently **no test anywhere asserts that org A cannot read org B's sales.** The script that *would* prove it — `tools/e2e-http.mjs`, which signs in over real HTTPS and walks `session_payload → pos_catalog → complete_sale` — is not in `.github/workflows/ci.yml` and did not run in this audit (needs `.env.db`).

**Impact** — The product's primary security claim rests on code review alone. A future policy edit, a new table added outside the `015_rls.sql` loop, a `SECURITY DEFINER` RPC that forgets `app.require_org()`, or a Supabase role-behaviour change would all pass CI green. In a multi-tenant POS, cross-tenant leakage is an extinction-level incident.

**Fix** —
1. Add negative-path RLS tests to the PGlite suite: `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claims', …)` for two seeded orgs, then assert each tenant sees exactly its own rows across all 62 tables. PGlite's superuser can still `SET ROLE`, which is enough to exercise policies.
2. Promote `npm run e2e` to a required CI job against a dedicated staging Supabase project with repository secrets.
3. Add a guard test: *every* table in `pg_tables` must appear in the RLS registry — so a new table cannot ship unprotected.

**Effort** — 3–5 days. **Highest security value in this report.**

---

#### F-03 · P0 · Zero production observability. The telemetry table is read but never written.

**Evidence** — `platform_log_events` is created (`066_developer_control_plane.sql:20`), indexed three ways, surfaced in the developer dashboard, and counted in `developer_summary` as `error_logs_24h`. **There is not a single `INSERT` into it** — in SQL or TypeScript. The dashboard's own empty state admits it: *"events appear when server-side ingestion is connected"* (`src/developer/views.ts:306`).

There is also **no `window.onerror`, no `unhandledrejection` handler, and no error-reporting SDK** anywhere in `src/`. 29 `console.*` calls in production code are the entire error pipeline — and `console` output does not leave the cashier's device.

**Impact** — You cannot detect: a till failing at a shop, an outbox backlog growing, an RPC error spike, a plugin crashing, a PostgREST schema-cache miss, or a failed deploy. You will learn about outages from angry phone calls, and you will have no data to diagnose them. The developer dashboard actively **misreports health** — `error_logs_24h` reads `0` because nothing writes, not because nothing is wrong.

**Fix** —
1. Ship a `log_event` RPC (rate-limited, org-scoped) and wire global `error` / `unhandledrejection` handlers plus RPC-failure interception to it, with a correlation ID per session.
2. Instrument the outbox: queue depth, oldest-item age, failure count — these are the POS-specific health signals that matter.
3. Add uptime + synthetic-sale monitoring and a paging destination.
4. Until (1) ships, **remove or clearly label `error_logs_24h`** so it stops reporting false health.

**Effort** — 1 week for a credible v1.

---

#### F-04 · P0 · No disaster recovery capability. No RPO, no RTO, no tested restore.

**Evidence** — No backup, restore, RPO/RTO, or incident documentation exists in `docs/` (21 files reviewed). No restore tooling in `tools/`. Supabase's managed backups may well be enabled, but **an untested backup is not a recovery plan** — and nothing in the repo evidences a drill.

**Impact** — A bad migration, a dropped table, a ransomware event, or a Supabase regional incident destroys every merchant's sales, stock, dues, and VAT history simultaneously. For a POS, "we lost yesterday" means merchants cannot reconcile cash, collect dues, or file returns. This is the finding most likely to end the business.

**Fix** — Declare RPO (suggest ≤ 15 min) and RTO (suggest ≤ 4 h); enable PITR on the Supabase plan that supports it; **perform a timed restore into an isolated project and reconcile row counts and financial totals**; write the runbook naming the owner and escalation path; re-drill quarterly; retain evidence.

**Effort** — 2–3 days for the first drill. Non-negotiable before any merchant's money is on the line.

---

#### F-05 · P0 · Database migrations are applied by hand, decoupled from code deploys.

**Evidence** — `deploy-pages.yml` builds and publishes the frontend only — **no migration step**. The repo root contains `apply-pending-migrations.sql`, a hand-assembled script the operator pastes into the Supabase SQL Editor, ending in `notify pgrst,'reload schema';`. Migration `073` (`discard_held_sale`) is committed to `main` but, per project notes, is **not yet applied to production**.

**Impact** — Production code and production schema drift apart silently and permanently. Frontend deploys are automatic; schema changes are a human remembering. The failure mode is a live app calling an RPC that does not exist → `PGRST202: could not find function in schema cache` → a cashier staring at a broken till. There is no rollback, no dry run, no audit of who applied what when. **The system is currently in this drifted state.**

**Fix** — Add a migration job to the deploy workflow (Supabase CLI `db push` or a scripted runner) gated on CI success, with a `schema_migrations` ledger, idempotent/transactional application, and an explicit expand→migrate→contract policy so schema changes are always backward-compatible with the previously deployed frontend. Delete the manual script once automated.

**Effort** — 2–3 days.

---

#### F-06 · P0 · Deploys are not gated on CI. A red build publishes to production.

**Evidence** — `ci.yml` and `deploy-pages.yml` both trigger independently on `push: branches: [main]`. The deploy job has **no `needs:` dependency on, and no awareness of, the CI job**. Combined with a single unprotected `main` branch (216 commits, no PR history, no `CODEOWNERS`), any push ships straight to every merchant's till.

**Impact** — Failing tests, a type error, or a broken build can reach production. With no observability (F-03), no rollback path, and the PWA service worker caching the broken shell, recovery would be slow and manual.

**Fix** — Make deploy `needs` a successful CI run (or merge into one workflow with a job dependency); enable branch protection on `main` requiring the CI check; add an explicit rollback procedure (redeploy a previous artifact + a kill-switch the service worker honours).

**Effort** — Half a day. **Lowest-effort P0 here.**

> ✅ **Code fixed 3 Oct 2026.** `deploy-pages.yml` now triggers on `workflow_run` of **CI**, `types: [completed]`, and the build job refuses to run unless `github.event.workflow_run.conclusion == 'success'`. Checkout is pinned to `github.event.workflow_run.head_sha` so what ships is the exact commit CI approved, not whatever `main` has drifted to. A job-summary step records the deployed SHA for rollback.
>
> ⚠️ **Still open — requires a repository setting, not code.** Enable branch protection on `main` requiring the CI status check, or a direct push still reaches production by passing CI on its own commit. **F-06 is not closed until that toggle is on.**

---

#### F-07 · P0 · No merchant data export, deletion, or retention capability.

**Evidence** — No `delete_organization`, `export_organization`, anonymization, purge, or retention logic exists in any migration or source file. Product/report CSVs are per-screen extracts, not a complete, portable organization export.

**Impact** —
- **Commercial:** merchants cannot leave with their data. This is an explicit question on every procurement checklist and a reasonable merchant demand on day one.
- **Legal:** no DSAR response, no right-to-erasure, no retention schedule. Customer PII (name, phone, dues) accumulates forever with no defined lifecycle.
- **Operational:** churned and test organizations persist indefinitely, growing cost and breach blast radius.

**Fix** — Ship (a) a complete, versioned, schema-documented org export (JSON + CSV bundle); (b) an account-closure workflow with a grace period, then hard delete or irreversible anonymization that preserves financial aggregates; (c) a written retention schedule; (d) a DSAR runbook. Publish Terms, Privacy Policy, subprocessor list, and a DPA template alongside.

**Effort** — 2 weeks engineering + legal review.

---

### P1 — Enterprise contract blockers

---

#### F-08 · P1 · Staff invitations trust an unverified email address.

**Evidence** — `accept_staff_invitations` (`052_staff_invitations.sql:202`) claims every unexpired invitation whose `email` matches `auth.users.email` for the caller. It **does not check `email_confirmed_at`**.

**Impact** — If Supabase's *Confirm email* setting is ever off (it is off by default in some project configurations, and `064`'s comment "no confirmation email" shows the project is already steering around confirmation), an attacker who learns a pending invitee's address can sign up with it and inherit the invited role — cashier, manager, or admin — in a shop they have no relationship with. The entire control depends on one dashboard toggle that is not asserted anywhere in code or CI.

**Fix** — Add `and (select email_confirmed_at from auth.users where id = p_user_id) is not null` to the claim loop. Add a startup/CI assertion that email confirmation is enabled. Consider a single-use invitation token instead of email matching.

**Effort** — 2 hours. **Best security-per-hour in this report.**

---

#### F-09 · P1 · Direct writes into `auth.users` / `auth.identities`, with a plaintext password as an RPC argument.

**Evidence** — `create_staff_account` (`064_admin_creates_staff.sql:20-105`) `INSERT`s directly into `auth.users` and `auth.identities`, setting `encrypted_password`, `email_confirmed_at = now()`, and hand-populating GoTrue's token columns with empty strings (with a comment explaining GoTrue "trips over NULLs"). `p_password` crosses the PostgREST boundary in plaintext.

**Impact** —
- **Fragility:** writing to the `auth` schema is explicitly unsupported by Supabase. A GoTrue upgrade that adds a `NOT NULL` column or changes identity semantics breaks staff creation in production — or silently creates users who cannot log in or recover.
- **Credential exposure:** the password appears in the RPC payload and is therefore reachable by any statement/request logging on the path (PostgREST logs, pooler logs, proxy traces, APM).
- **Enumeration oracle:** the returned `created: false` tells any org admin whether an arbitrary email is already registered on the platform.
- **Unconsented membership:** an existing user from another tenant is silently added to the caller's org — no invitation, no notification, no acceptance. They simply find an unknown shop in their switcher. Usable for phishing and for polluting a third party's audit identity.

**Fix** — Move account creation to a Supabase Edge Function using the Admin API (service-role key server-side only) with `invite_user_by_email`, so GoTrue owns its own schema. Never accept passwords as RPC parameters. Return a uniform response regardless of pre-existence. Require explicit acceptance before linking a pre-existing account to a new org, and notify the account owner.

**Effort** — 3–4 days.

---

#### F-10 · P1 · No security headers, and the current host cannot set them.

**Evidence** — No CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy` anywhere — not in `index.html`, not in the build, not in the workflow. GitHub Pages **cannot serve custom response headers at all**, so this is unfixable on the current platform.

**Impact** — No defence-in-depth against XSS, clickjacking, or protocol downgrade. Although the app builds DOM programmatically (only 5 `innerHTML` uses, all with generated SVG/chart markup, and zero `eval`), a single future mistake becomes fully exploitable with no CSP backstop. The absence of a CSP is an automatic finding in any enterprise security questionnaire and in most pen tests.

**Fix** — Put the custom domain behind Cloudflare (free tier suffices) or Netlify/Vercel and serve a strict CSP (`default-src 'self'`; explicit `connect-src` for the Supabase project; `frame-ancestors 'none'`), HSTS with preload, `nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`. Deploy report-only first.

**Effort** — 1–2 days including CSP tuning.

---

#### F-11 · P1 · Three third-party CDNs on the critical render path, with no SRI and no offline fallback.

**Evidence** — `index.html` loads stylesheets from `fonts.googleapis.com` (Material Symbols Rounded), `cdnjs.cloudflare.com` (Font Awesome 6), and `fonts.maateen.me` (Kalpurush, the Bangla webfont). **`integrity=` appears zero times.** `dist/sw.js` caches same-origin requests only (`if (url.origin !== scope.origin … ) return;`) — so none of these are available offline.

**Impact** —
- **Offline POS is visually broken.** Icons are Material Symbols *ligatures* (`src/components/ui/h.ts:98`): with the font unavailable, buttons render the literal text `shopping_cart`, `delete`, `add`. The product's headline offline capability degrades to an unusable UI exactly when it matters most.
- **Bangla text breaks** offline or if `fonts.maateen.me` — a small community-operated host with no SLA — goes down. A single third party can break Bangla rendering for every merchant.
- **Supply chain:** without SRI, a compromised CDN can inject CSS. CSS alone is enough to exfiltrate typed values via attribute selectors and to overlay phishing UI.
- Google Fonts is intermittently unreliable on some Bangladeshi networks.

**Fix** — Self-host all three (subset the icon fonts to glyphs actually used — typically < 20 KB), include them in the service-worker shell, and drop the external origins entirely. This simultaneously fixes offline, removes the SRI gap, tightens the future CSP, and improves cold load.

**Effort** — 1 day. **Fixes four findings at once.**

---

#### F-12 · P1 · Seven dependency advisories and no automated supply-chain gate — but no non-breaking fix exists.

> **Corrected 3 Oct 2026 (same day).** The first version of this finding recommended "upgrade Vite to ≥ 5.4.20 / 7.x and Tailwind to a patched release, 1 day." That was wrong, and the correction matters because the original advice would have sent someone into a major-version migration weeks before a pilot. Verified detail below.

**Evidence** — `npm audit`: **6 high, 1 moderate**. Crucially, `npm audit --omit=dev` reports **`found 0 vulnerabilities`** — the only runtime dependency is `@supabase/supabase-js@2.109.0` and it is clean. Nothing vulnerable reaches a merchant's browser.

All seven collapse to **two root causes, and neither has a non-breaking fix**:

| Advisory | Range | Reality |
|---|---|---|
| `braces` → `micromatch` → `fast-glob` → `chokidar` → `tailwindcss` | `braces <=3.0.3` | **3.0.3 is the latest published release.** No patched version exists. npm's only offered fix is `tailwindcss@4.3.3` — a major upgrade and a CSS-first config rewrite |
| `vite` (3 advisories) + `esbuild` (pinned by Vite 5) | `vite <=6.4.2` | Already on `vite@5.4.21`, the current v5. Fix is `vite@8.3.2` — major. Two of the three are **Windows-only dev-server** issues; CI is Ubuntu |

Also absent: no `dependabot.yml`, no `npm audit` in CI, no secret scanning, no CodeQL, no `SECURITY.md`, no `LICENSE` (on a **public** repository).

**Impact** — Direct runtime exposure is **nil**. The real exposures are (a) a compromised build toolchain injecting code into every merchant's bundle, and (b) procurement: "7 advisories, no scanning, no disclosure policy" fails review on paperwork grounds regardless of exploitability. The absence of any gate is a larger problem than these specific advisories, because nothing would catch a genuinely dangerous package entering `dependencies`.

**Fix** — Gate on what ships, report the rest:
1. `npm audit --omit=dev --audit-level=high` as a **required** CI step — currently passes, so it is a tripwire for the first vulnerable runtime dependency.
2. `npm audit` unguarded as a **report-only** step, with the exceptions documented inline and revisited whenever the list changes.
3. Dependabot configured so Tailwind 4 and Vite 8 arrive as reviewable PRs and get scheduled deliberately.
4. `SECURITY.md` with private disclosure via GitHub Security Advisories; `LICENSE`; `CODEOWNERS` on migrations, auth, repositories, CI, and receipt/VAT output.
5. Enable GitHub secret scanning + push protection — this repo has already had one PAT auto-revoked after exposure (F-28).

**Do not** rush Tailwind 4 / Vite 8 before the pilot. Schedule them as their own tracked work with a full regression pass.

**Effort** — Gate + Dependabot + governance files: half a day *(implemented 3 Oct, commit below)*. Major upgrades: 3–5 days, scheduled separately.

---

#### F-13 · P1 · The highest-risk modules have no tests.

**Evidence** — Feature directories with **zero** test files:

| Module | Why it is high risk |
|---|---|
| `src/features/register` | Cash drawer: open/close, float, variance, reconciliation |
| `src/features/users` | Account creation, staff lifecycle |
| `src/features/roles` | **Privilege assignment** |
| `src/features/audit` | The audit trail itself |
| `src/features/customers` | PII + dues ledger |
| `src/features/analytics`, `dashboard` | Owner-facing financial figures |
| `src/developer` (3 files, 0 tests) | **Platform control plane + support impersonation** |

1 145 tests exist, but coverage is concentrated on POS, offline, and plugins. Cash control, privilege management, audit integrity, and the impersonation console are the four areas where a defect is a fraud or breach event — and all four are untested.

**Fix** — Prioritise tests for: register open/close with variance; role grant/revoke and permission denial; support-session start/expiry/end with audit assertions; audit-trail completeness for every privileged mutation. Add coverage thresholds for these paths.

**Effort** — 1–2 weeks.

---

#### F-14 · P1 · No session controls for a shared physical terminal.

**Evidence** — No idle timeout, inactivity lock, screen lock, or cashier PIN anywhere in `src/`. No MFA (`auth.mfa*` unused; MFA appears only as a *recommendation* in `docs/19` for the developer dashboard). `persistSession: true` with `autoRefreshToken: true` means a POS session stays live indefinitely.

**Impact** — A POS terminal is a shared, physically exposed device. A cashier walks away and anyone can issue refunds, void sales, read the customer ledger, or export data as that cashier. There is no way to attribute or prevent it. Enterprise and multi-outlet buyers treat terminal session policy as mandatory — and **the platform-owner account, which can impersonate any tenant, has no MFA at all.**

**Fix** — Add a configurable idle lock with a quick PIN/password re-entry that preserves cart state; require step-up re-authentication for refunds, voids, register close, and role changes; **enforce MFA for all `platform_*` roles immediately** (Supabase supports TOTP enrolment).

**Effort** — 1 week (MFA for platform roles alone: ~1 day).

---

#### F-15 · P1 · Localization is ~14 % complete despite a 100 %-translated dictionary.

**Evidence** — `src/shared/i18n/strings.ts` contains 134 keys in `en` and **134 in `bn` — a genuinely complete dictionary.** But only 23 of 60 feature files call `t()`, and an approximate scan finds **~847 hardcoded English user-visible literals** (`text:`/`label:`/`placeholder:`/`title:`) across `src/features` (452), `src/plugins` (371), and `src/components` (6).

So the *shell* is bilingual and the *product* is not. A Bangla-speaking cashier sees Bangla navigation wrapped around English POS, products, stock, purchases, dues, reports, errors, and receipts.

**Impact** — For a Bangladesh-first POS this is a primary adoption barrier, a training cost, and an operator-error source at the cash counter. It also quietly blocks every future market.

**Fix** — Add a lint rule banning bare string literals in user-visible component props; extract the ~850 strings; prioritise POS → products → stock → dues → errors → receipts; test Bangla typography, wrapping, numerals, and input. The infrastructure is already right — this is extraction work, not architecture.

**Effort** — 3–4 weeks, parallelisable.

---

#### F-16 · P1 · No performance budgets; the critical path is ~225 KB gzipped JS.

**Evidence** — `dist/assets/index-*.js` is **572 KB raw / 171 KB gzip**, plus `supabase-*.js` at 208 KB / 54 KB gzip. Both are in the initial `index.html` + service-worker shell. Vite emits its >500 KB chunk warning on every build. The SW precaches all 38 chunks (~1.5 MB) on install. No budgets, no Lighthouse gate, no low-end-device benchmark, no load test.

**Impact** — Target hardware is entry-level Android on 3G/4G in Bangladesh. ~225 KB of gzipped JS plus three blocking CDN stylesheets plus a 1.5 MB first-install precache is a slow, battery-hungry cold start on exactly the devices merchants will use. "Time to first scan" is the metric that decides whether a cashier adopts the product, and it is currently unmeasured.

**Fix** — Route-split so `/login` and `/pos` do not carry the whole app; lazy-load Supabase after first paint where possible; set and CI-enforce budgets (suggest: ≤ 120 KB gz initial JS, TTI ≤ 3 s on a mid-tier Android over simulated 4G); split the SW precache into critical shell vs. on-demand; run a load test at realistic scale (500 orgs × 5 k SKUs × 1 k sales/day) against the indexes.

**Effort** — 1 week for budgets + splitting; 3 days for a load test.

---

### P2 — Scale and procurement blockers

---

#### F-17 · P2 · No enterprise administration surface.

No SSO (SAML/OIDC), no SCIM provisioning, no IP allowlisting, no session policy, no public API, no webhooks, no audit-log export, no configurable audit retention, no multi-entity consolidation, no SLA, no status page. Any buyer above single-shop SMB will ask for most of these in the first call. (Scoped work — build only what your target segment demands.)

#### F-18 · P2 · Accessibility is unevidenced and thin.

Across 299 files: 40 `aria-label`, 5 `aria-live`, 8 `aria-expanded`, 2 `aria-modal`, **0 `aria-describedby`** (so form errors are not programmatically associated with inputs), and **0 `prefers-reduced-motion` handling**. `index.html` sets `user-scalable=no, maximum-scale=1.0`, which **blocks pinch-zoom — a direct WCAG 1.4.4 failure** and a real problem for presbyopic shop owners reading small totals. No axe automation, no keyboard matrix, no screen-reader pass, no contrast report.

> ✅ **F-18a fixed 3 Oct 2026.** The viewport is now `width=device-width, initial-scale=1.0, viewport-fit=cover` — the zoom lock is gone. Worth noting the lock was always half-fiction: iOS Safari has ignored `user-scalable=no` since iOS 10, so every iPhone could already pinch this app. Removing it makes Android match iOS rather than exposing untested behaviour. If zoom breaks a sticky element, fix the CSS; do not re-lock the viewport.
>
> The rest of F-18 — `aria-describedby` on form errors, `prefers-reduced-motion`, axe automation, keyboard matrix, screen-reader and contrast testing — remains open.

#### F-19 · P2 · No rate limiting or abuse controls on any RPC.

Zero rate-limit logic in 74 migrations or in `src/`. An authenticated user can call `analytics_query`, `report_rows`, `plugin_rpc`, or `complete_sale` without bound. Supabase's platform limits are not application-aware. Add per-org/per-user quotas on expensive and sensitive RPCs (especially `create_staff_account`, `invite_staff`, and the report/analytics endpoints), and a circuit breaker on the client.

#### F-20 · P2 · 13 plugin tables have RLS enabled but not `FORCE`d.

`plg_*` tables, `plugin_data`, `plugin_packages`, `plugin_package_migrations`, `plugin_package_permissions` — all have RLS but lack `FORCE ROW LEVEL SECURITY`, unlike the 49 core tables. Inconsistent hardening in exactly the extension surface most likely to host third-party code later. Apply `FORCE` uniformly and assert it in CI.

#### F-21 · P2 · Developer control plane: no tests, no MFA, no bootstrap documentation.

`platform_user_roles` grants `platform_owner` with permission `'*'` — able to view every shop and start a support session into any tenant. There is no documented bootstrap procedure (how does the first platform owner get created, and who audits it?), no MFA requirement (F-14), and `src/developer` has **zero tests**. The RLS and grant design is sound; the operational controls around the most privileged role on the platform are absent.

#### F-22 · P2 · Unindexed foreign keys on growing tables.

87 indexes exist and the hot read paths are well covered (`sales (organization_id, created_at desc)`, `products (search_text gin_trgm_ops)`, `sale_items (sale_id)`, the `client_ref` unique). But ~104 FK columns have no leading-column index. Most will never matter; these will: `sale_items.variant_id`, `sale_payments.method_id`, `stock_movements.user_id`, `expenses.session_id`, `sales.register_id`, `sales.created_by`, `audit_logs.actor_id`. Unindexed FKs also make cascade deletes and tenant purges (F-07) progressively slower. Confirm with `pg_stat_user_tables` under load before adding — do not index speculatively.

---

### P3 — Hygiene

| ID | Finding |
|---|---|
| F-23 | **Duplicate migration ordinal `051`** — `20260926_051_loyalty_plugin.sql` and `20260929_051_warranty_line_optout.sql`. Filename sort keeps ordering deterministic (date prefix dominates), so this is cosmetic today, but it is confusing in a manual-apply process (F-05) and invites mis-sequencing. Renumber. |
| F-24 | **`apply-pending-migrations.sql` is tracked in the repo root.** A transient operational artifact committed as source. Move to `tools/` or delete once F-05 automates migrations. |
| F-25 | **No `LICENSE`, `SECURITY.md`, `CODEOWNERS`, `CONTRIBUTING.md`, or `CHANGELOG.md`.** Procurement and security reviewers look for all five. |
| F-26 | **29 `console.*` calls in production code** are the only error signal. Replace with the structured logger from F-03. |
| F-27 | **`client_ref` fallback uses `Math.random()`** (`offline/queue.ts:117`) when `crypto.randomUUID` is unavailable. Unreachable on target browsers, but because `UNIQUE (organization_id, client_ref)` makes a collision look like an idempotent replay, a collision would *silently swallow a real sale*. Throw instead of degrading. |
| F-28 | **Credentials were shared in plaintext during setup** (GitHub PAT, Supabase DB password). Rotate both, and move to fine-grained tokens with least privilege. |

---

## 5. Delta since the 29 September audit

Four days, 7 commits, +3 migrations, +94 tests.

### Closed

| Prior item | Status |
|---|---|
| PWA manifest, icons, versioned SW, safe update lifecycle | ✅ Verified in `dist/` — correctly implemented |
| Bangla dictionary gaps | ✅ `bn` now at 134/134 keys (but see F-15: UI coverage, not dictionary, is the problem) |
| OAuth redirect-to-localhost | ✅ Diagnosed as Supabase URL config; PKCE flow confirmed in `supabase.ts:37` |
| Held-sale lifecycle | ✅ `discard_held_sale` shipped… **but not applied to production** (F-05) |

### Still open — now re-stated with hard evidence

Prior P0s **monitoring**, **backup/restore**, **release E2E**, **legal/privacy package**, and **security headers** are all unchanged and reappear here as F-03, F-04, F-02, F-07, and F-10. Four days is not a fair window for these; they are flagged as unchanged, not as neglected.

### Regressions

- **Dependency advisories 2 → 7** (F-12). Drift, plus no automated gate.

### New in this audit

F-01 (password recovery), F-02 (RLS is unproven by execution), F-05/F-06 (release pipeline integrity), F-08/F-09 (invitation and `auth.users` handling), F-11 (CDN/offline icon failure), F-13 (untested high-risk modules), F-14 (terminal session policy), F-19 (rate limiting), F-21 (control-plane governance).

---

## 6. Remediation plan

### Sprint 0 — one week, ~5 engineer-days. Do this before the next merchant signs up.

| # | Item | Effort |
|---|---|---|
| 1 | **F-06** Gate deploy on CI + branch protection | 0.5 d |
| 2 | **F-08** Require `email_confirmed_at` in invitation claim | 0.25 d |
| 3 | **F-01** Password reset + change password | 1.5 d |
| 4 | **F-11** Self-host icon/Bangla fonts into the SW shell | 1 d |
| 5 | **F-12** Patch Vite/Tailwind; add `npm audit` gate + Dependabot | 0.5 d |
| 6 | **F-14 (partial)** Enforce MFA on all `platform_*` roles | 0.5 d |
| 7 | **F-03 (partial)** Global error handlers + `log_event` RPC | 1 d |

*Outcome: locked-out users can recover, the offline UI works offline, a red build cannot ship, the invitation escalation path is closed, and errors become visible.*

### Sprint 1 — weeks 2–4

**F-02** executing RLS tests + `e2e` in CI · **F-04** DR drill with documented RPO/RTO · **F-05** automated migrations with a version ledger · **F-03** complete telemetry, outbox metrics, alerting, on-call · **F-09** move account creation to an Edge Function · **F-10** Cloudflare + CSP/HSTS.

### Sprint 2 — weeks 5–8

**F-07** export + deletion + retention + legal pack · **F-13** tests for register/roles/audit/developer · **F-16** performance budgets + load test · **F-19** rate limiting · **F-20** uniform `FORCE RLS`.

### Sprint 3 — weeks 9–12

**F-15** localization extraction (~850 strings) · **F-18** WCAG 2.2 AA pass (start by removing `user-scalable=no`) · external penetration test · **F-17** enterprise admin features, scoped to actual demand.

---

## 7. Launch gate

Do not announce general availability until every row is evidenced, dated, and owned.

| # | Gate | Evidence required |
|---|---|---|
| 1 | Users can recover their own accounts | F-01 shipped; reset tested end-to-end |
| 2 | Tenant isolation proven by execution | F-02 — cross-tenant denial tests green in CI |
| 3 | Production failures are visible within 5 minutes | F-03 — alert fired and acknowledged in a drill |
| 4 | Data loss is survivable | F-04 — timed restore with reconciled financial totals |
| 5 | Schema and code deploy together | F-05/F-06 — automated, gated, rollback rehearsed |
| 6 | Merchants can leave with their data | F-07 — export + deletion shipped |
| 7 | Terms, Privacy Policy, DPA published | Reviewed by counsel |
| 8 | Security headers live | F-10 — observable in response headers |
| 9 | Zero high advisories | F-12 — `npm audit` gate green |
| 10 | Cash, roles, audit, support paths tested | F-13 |
| 11 | Real-hardware matrix validated | Printer, scanner, drawer, scale, low-end Android, iOS Safari |
| 12 | External penetration test | Report + remediation of criticals/highs |
| 13 | VAT output reviewed by a practitioner | Written opinion on Mushak-6.3 output |

---

## 8. Conclusion

Mekholi's **engineering is ahead of its operations by roughly a year**, and that is the right way round — the expensive, hard-to-retrofit decisions were made correctly. RLS on all 62 tables, `search_path` pinned on every definer function, `numeric(14,2)` money with real row locks, idempotent offline replay keyed on a never-regenerated `client_ref`, enforced architecture boundaries, and a 1 145-test gate are not what early POS products usually look like. Nothing in this report asks you to undo any of it.

What the report asks for is **proof and operability**. Three findings capture the shape of the problem:

- The database is designed so a tenant cannot read another tenant's sales — and **no test in the system actually tries** (F-02).
- A telemetry table, three indexes, and a dashboard were built to surface production errors — and **nothing writes to it**, so the dashboard reports perfect health by construction (F-03).
- A user who forgets their password has **no way back in** (F-01).

Each is a small amount of work relative to what already exists. Together they are the difference between software that is correct and a service that can be trusted with a shop's money.

**Recommendation:**

1. Execute **Sprint 0 (one week)**, then continue the supervised pilot.
2. Hold public launch until all seven **P0**s are closed with dated evidence.
3. Do not pursue enterprise or multi-outlet contracts until **P1** is closed and an external penetration test is complete.
4. Re-audit at the end of Sprint 2.

The foundation is sound. The work ahead is the unglamorous kind that turns good software into a business merchants can rely on.

---

*Prepared 3 October 2026 against revision `0656d79`. All findings are reproducible from the working tree; commands and file:line references are given inline. This is an engineering assessment, not a legal, tax, PCI, or accessibility certification.*
