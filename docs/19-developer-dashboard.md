# 19 — Developer Dashboard (Control Plane)

## 1. Purpose

The Developer Dashboard is Mekholi’s internal control plane. It is not a richer version of the shop dashboard and it must never look like a shop’s POS workspace.

It serves Mekholi developers and authorized support/operators who need to:

- see all shops and their operational state;
- inspect a shop’s profile, plan, staff summary, branches and installed plugins;
- publish and maintain plugins;
- define whether a plugin is free or paid;
- manage plugin versions, permissions, dependencies, migrations and documentation;
- inspect plugin and worker health for a shop;
- investigate failures without silently entering or modifying the shop;
- see an immutable history of platform and support actions.

The existing shop dashboard continues to answer: **“How is my business doing?”**

The Developer Dashboard answers: **“How is the Mekholi platform and each tenant running?”**

---

## 2. Product boundary

### 2.1 Shared login experience

The login page should use the same visual system and authentication component as the shop application:

- same Mekholi identity;
- same typography, inputs, buttons and validation;
- same email/password and supported OAuth mechanisms;
- same error translation and session handling;
- same responsive behavior and accessibility rules.

The login form is shared. The destination and information are not.

After authentication, the server resolves the account’s platform access:

- a normal shop user enters the shop application;
- a platform developer enters the Developer Dashboard;
- an account with both kinds of access is shown a safe workspace chooser;
- a user without developer access must never be able to reach developer data by typing a developer URL.

There must be no “developer mode” query parameter, local-storage flag, hidden keyboard shortcut or client-only role switch. Developer authorization is server-owned.

### 2.2 Separate information architecture

The Developer Dashboard must have its own:

- route namespace;
- navigation tree;
- dashboard widgets;
- repository contracts;
- server API;
- permissions;
- audit vocabulary;
- visual labels and empty states.

Recommended route namespace:

```text
/developer
/developer/shops
/developer/shops/:shopId
/developer/shops/:shopId/plugins
/developer/shops/:shopId/logs
/developer/plugins
/developer/plugins/new
/developer/plugins/:pluginKey
/developer/plugins/:pluginKey/versions/:version
/developer/workers
/developer/audit
/developer/settings
```

These are History API routes. No hash routing.

### 2.3 Control plane versus tenant plane

The shop application is tenant-scoped. The Developer Dashboard is cross-tenant and therefore materially more dangerous.

It must not obtain broad access by weakening shop RLS or by placing a service-role key in the browser. Cross-tenant reads and all privileged writes must go through a narrowly designed server-side control-plane API, such as Supabase Edge Functions or a dedicated backend using a service credential that never reaches Vite code.

---

## 3. Developer roles and permissions

A single `is_developer` boolean is not sufficient. Platform permissions should be explicit and independently auditable.

### 3.1 Suggested platform roles

| Role | Purpose |
|---|---|
| Platform owner | Full control, including developer access and billing configuration |
| Plugin developer | Create packages, versions, documentation and release candidates |
| Release manager | Approve and publish or withdraw plugin versions |
| Support operator | Inspect shops and logs; cannot publish code or change billing |
| Reliability operator | Inspect worker health, retry safe jobs and manage incidents |
| Billing operator | Manage plugin pricing and shop entitlements; cannot publish code |
| Auditor | Read-only access to platform history and security-sensitive actions |

### 3.2 Suggested permission keys

```text
developer.dashboard.view
platform.shops.view
platform.shops.view_sensitive
platform.shops.suspend
platform.shops.support_session
platform.plugins.view
platform.plugins.create
platform.plugins.edit
platform.plugins.publish
platform.plugins.withdraw
platform.plugins.pricing
platform.plugins.permissions
platform.plugins.migrations
platform.entitlements.view
platform.entitlements.manage
platform.logs.view
platform.logs.view_payload
platform.workers.retry
platform.workers.cancel
platform.audit.view
platform.developers.manage
```

Permissions are checked in the server API. Frontend checks only hide unavailable controls.

### 3.3 Step-up authentication

Require recent authentication, and preferably MFA, before:

- publishing or withdrawing a plugin version;
- changing plugin pricing;
- granting a paid entitlement;
- suspending a shop;
- starting a support session;
- revealing sensitive log payloads;
- adding another platform developer.

---

## 4. Developer shell and visual design

### 4.1 Design direction

Reuse Mekholi’s design tokens and component kit, but clearly distinguish the control plane:

- top-left product label: **Mekholi Developer**;
- persistent environment badge: Development, Staging or Production;
- global shop/plugin search in the top bar;
- restrained operational palette rather than retail/POS emphasis;
- warning banner in production when a write-capable developer is signed in;
- UTC and shop-local times shown together where incidents depend on time zones;
- IDs and versions use copyable monospace text;
- every privileged action displays the target environment and tenant.

The developer shell should never expose POS actions such as “New sale,” “Open register” or cashier shortcuts.

### 4.2 Navigation

Recommended primary navigation:

1. Overview
2. Shops
3. Plugins
4. Workers & Jobs
5. Platform Logs
6. Audit Trail
7. Developer Access
8. Platform Settings

Navigation items are permission-gated.

### 4.3 Global search

Search should accept:

- shop name;
- organization ID;
- slug;
- owner email, only with sensitive-view permission;
- plugin key;
- plugin version;
- invoice or correlation ID for support investigation;
- worker job ID.

Results must identify the entity type and must not mix a shop result with a plugin package result without a label.

---

## 5. Developer overview dashboard

The overview is platform health, not business analytics.

### 5.1 Headline cards

- Total active shops
- Shops created today / this month
- Active users in the last 24 hours
- Shops with plugin errors
- Failed worker jobs
- Offline queues with prolonged backlog
- Current published plugin versions
- Paid-plugin trials expiring soon
- Platform incidents
- Database migration compatibility state

Each card links to a filtered list rather than being decorative.

### 5.2 Operational panels

#### Shop growth

- New shops by day/week/month
- Shop type distribution
- Active versus dormant shops
- Shops by application version

#### Plugin health

- Install count by plugin
- Version distribution
- Failed installations
- Plugins blocked by incompatible core API
- Worker timeout/error rate by plugin
- Expired or invalid entitlements

#### Sales infrastructure health

The control plane should not expose every shop’s revenue by default. It should show operational facts instead:

- `complete_sale` error rate;
- offline replay backlog;
- duplicate replay prevented count;
- average sale RPC latency;
- receipt-generation failures;
- Realtime/outbox lag.

Viewing a shop’s actual financial totals requires a separate sensitive permission and a recorded support reason.

#### Recent incidents

A timeline of:

- plugin installation failures;
- worker circuit breakers opening;
- repeated migration failures;
- authorization anomalies;
- elevated RPC error rates;
- platform deployment events.

---

## 6. Shops directory

### 6.1 Table columns

- Shop name
- Organization ID / slug
- Shop type
- Owner summary
- Plan/status
- Branch count
- Staff count
- Installed plugin count
- Application/client versions
- Last activity
- Health state
- Created date

### 6.2 Filters

- Active, suspended, dormant
- Shop type
- Created date
- Has plugin errors
- Has worker backlog
- Has offline queue backlog
- Plugin installed
- Plugin version
- Paid/free plan
- Trial expiring
- Client version
- Region/timezone

### 6.3 Bulk actions

Bulk operations should be rare and tightly controlled. Safe examples:

- export non-sensitive shop inventory;
- notify affected shops of an incident;
- schedule a compatibility check;
- attach an internal tag.

Do not provide bulk plugin installation, bulk suspension or bulk entitlement changes without a separately approved rollout system, preview, dry run and rollback plan.

---

## 7. Shop detail workspace

A shop detail page should be organized as tabs so information is discoverable without creating one enormous support screen.

### 7.1 Overview tab

Display:

- organization name, ID and slug;
- shop type;
- currency, timezone and locale;
- logo and public profile fields;
- creation date and last activity;
- owner and membership summary;
- branch, warehouse and register counts;
- current client versions;
- plan, trial and entitlement summary;
- overall health and active incidents.

Provide copy buttons for IDs. Sensitive fields must be masked unless permission allows them.

### 7.2 Configuration tab

Read-only by default:

- organization settings;
- payment methods;
- tax configuration;
- units;
- branch configuration;
- receipt settings;
- enabled capabilities;
- environment and API compatibility.

Any editing must use an explicit “Edit as platform operator” flow with reason, preview, validation and audit.

### 7.3 Staff and access tab

Display:

- staff count;
- active/disabled memberships;
- roles;
- branch restrictions;
- pending invitations;
- last successful sign-in where available;
- failed sign-in/security events.

The developer dashboard should not reveal passwords and must not offer “set password” as routine support functionality. Account recovery should use the auth provider’s secure recovery process.

### 7.4 Branches and devices tab

- Branches, warehouses and registers
- Registered Android/browser devices
- Client version and last synchronization
- Printer/scanner configuration state, without secrets
- Offline queue depth per device
- Last successful sync
- Clock/timezone drift warnings

### 7.5 Shop plugins tab

For every package, show:

- name and key;
- installed/enabled state;
- installed version versus latest version;
- free/paid status;
- entitlement/trial state;
- dependencies and conflicts;
- migrations applied/pending;
- permissions contributed;
- current configuration with sensitive keys masked;
- runtime registration state;
- last load error;
- worker health;
- install/disable/configure audit history.

Developer actions:

- inspect installation;
- validate compatibility;
- retry an idempotent failed installation;
- grant/revoke entitlement with reason and expiry;
- disable a malfunctioning plugin in an emergency;
- schedule an upgrade;
- compare stored configuration with the manifest schema.

Direct installation into a production shop should require:

1. permission;
2. recent authentication;
3. compatibility check;
4. impact preview;
5. migration preview;
6. reason/ticket reference;
7. explicit confirmation naming the shop;
8. immutable audit entry.

### 7.6 Activity tab

A tenant-scoped operational timeline:

- sign-ins and membership changes;
- plugin changes;
- configuration changes;
- worker/job events;
- synchronization failures;
- application errors;
- platform support actions.

Business events such as every sale should not flood this timeline. They belong in dedicated shop records and should appear only when investigating a correlated incident.

### 7.7 Data health tab

Read-only checks:

- tables missing RLS;
- unresolved migrations;
- orphaned role assignments;
- plugin schema violations;
- stock ledger/balance reconciliation status;
- outbox lag;
- queued-sale replay health;
- report/RPC compatibility;
- browser/Android contract version.

Checks should report evidence and timestamps, not merely green/red badges.

---

## 8. Plugin catalogue management

### 8.1 Plugin record

A plugin package requires:

- immutable key;
- display name;
- short description;
- category: core, optional or industry;
- icon and cover;
- owner/team;
- support contact;
- current lifecycle state;
- semantic version;
- required core API range;
- dependencies;
- conflicts;
- permission definitions;
- settings schema;
- pricing definition;
- package migrations;
- release notes;
- documentation file;
- test and validation evidence.

### 8.2 Documentation

Use a canonical Markdown documentation file per plugin. Existing plugins use `DETAILS.md`; if the product requires `README.md`, standardize the package contract and support one canonical name rather than ambiguous duplicates.

Recommended sections:

```text
# Plugin name

## What it does
## Who it is for
## Features
## Data it reads
## Data it writes
## Permissions
## Dependencies
## Configuration
## Installation impact
## Reports and screens added
## Offline behavior
## Android behavior
## Privacy and retention
## Limitations
## Troubleshooting
## Changelog
```

The Developer Dashboard renders sanitized Markdown. Raw HTML and executable scripts are not allowed.

### 8.3 Free and paid plugins

Pricing definition should support:

- Free
- Paid monthly
- Paid yearly
- One-time purchase, if desired later
- Trial duration
- Price and currency
- Per-shop or per-branch billing unit
- Grace period
- Availability by environment/region

Separate these concepts:

- **Package price:** catalogue policy
- **Entitlement:** whether a shop may run it
- **Installation:** whether database/runtime capability is installed
- **Enabled state:** whether it is active now

A payment or entitlement failure must not delete plugin data.

### 8.4 Permission editor

Every permission must be namespaced:

```text
<plugin-key>.<capability>
```

The editor shows:

- key;
- human label;
- category;
- description;
- which screens/actions use it;
- which system/custom roles currently inherit it through wildcards;
- impact of adding, renaming or removing it.

Published permission keys should be treated as API. Renaming one requires a migration strategy.

### 8.5 Settings-schema editor

Supported field types should match the plugin host’s renderer:

- text;
- number;
- boolean;
- select;
- secret-reference, if server-side secret storage is introduced.

Validation includes duplicate keys, unsupported defaults, invalid options and configuration-size limits.

Secret values must never be stored in browser-readable `plugins.config`.

### 8.6 Version workflow

Suggested lifecycle:

```text
Draft → Validating → Release candidate → Approved → Published → Deprecated → Withdrawn
```

A version becomes publishable only after:

- manifest validation;
- semantic version validation;
- core API compatibility check;
- dependency/conflict check;
- permission namespace validation;
- migration checksum generation;
- migration apply/rollback simulation where possible;
- plugin schema/RLS validation;
- unit tests;
- browser integration tests;
- Android/API-contract checks where applicable;
- documentation presence;
- release notes;
- reviewer approval.

Published migration files are immutable. A checksum change must create a new migration/version, never rewrite history.

### 8.7 Release and rollout

Support staged rollout:

1. Internal shops
2. Selected pilot shops
3. Percentage rollout
4. General availability

Track:

- installation success rate;
- worker error/timeout rate;
- client compatibility;
- rollback/disable events;
- support incidents.

Withdrawing a version prevents new installations but does not destructively remove existing tenant data.

---

## 9. Shop worker and plugin logs

### 9.1 What “worker logs” mean

The current client plugin worker already records runtime statistics such as:

- run count;
- total and average duration;
- slowest duration;
- failures;
- timeouts;
- circuit-breaker/tripped state.

The Developer Dashboard needs server-visible telemetry rather than relying only on one browser tab’s memory.

### 9.2 Structured log event

Recommended shape:

```ts
interface PlatformLogEvent {
  id: string
  occurredAt: string
  receivedAt: string
  environment: 'development' | 'staging' | 'production'
  severity: 'debug' | 'info' | 'warning' | 'error' | 'critical'
  source: 'web' | 'android' | 'database' | 'edge-function' | 'plugin-worker' | 'sync-worker'
  organizationId: string | null
  branchId: string | null
  userId: string | null
  deviceId: string | null
  pluginKey: string | null
  pluginVersion: string | null
  action: string
  message: string
  correlationId: string
  durationMs: number | null
  outcome: 'ok' | 'failed' | 'timeout' | 'cancelled' | 'vetoed' | null
  errorCode: string | null
  retryable: boolean | null
  metadata: Record<string, unknown>
}
```

### 9.3 Log views

#### Global logs

Filters:

- time range;
- environment;
- severity;
- shop;
- plugin;
- version;
- source;
- action;
- outcome;
- error code;
- correlation ID;
- device/client version.

#### Shop logs

Pre-filtered to one organization, with shop-local time shown next to UTC.

#### Plugin logs

Aggregate by plugin/version:

- calls;
- p50/p95/p99 duration;
- error rate;
- timeout rate;
- top error codes;
- affected shops;
- first/last occurrence;
- release comparison.

#### Worker/job details

Show:

- job identity;
- queue and worker type;
- attempt count;
- next retry;
- lease/lock state;
- payload summary;
- correlation chain;
- result/error;
- related shop, device and plugin;
- retry/cancel controls where safe.

### 9.4 Privacy and redaction

Never log:

- passwords;
- access/refresh tokens;
- API keys;
- full authorization headers;
- card data;
- raw customer addresses or phone numbers unless specifically required and redacted;
- full receipt payloads by default;
- plugin configuration secrets.

Create server-side redaction before storage. Hiding fields only in the UI is insufficient.

Sensitive payload reveal requires a separate permission and creates an audit event.

### 9.5 Retention

Suggested defaults:

- debug: 7 days;
- info: 30 days;
- warning/error: 90 days;
- critical/security events: 1 year or policy-defined;
- immutable developer audit: longer, according to compliance requirements.

Retention and deletion jobs must be visible in worker health.

### 9.6 Safe retries

Only explicitly idempotent jobs may have a Retry button.

The UI must show why retry is safe, for example:

- queued sales use `client_ref` idempotency;
- plugin migration records use filename/checksum;
- outbox consumers deduplicate event IDs.

Unknown or non-idempotent operations require escalation rather than a generic retry.

---

## 10. Platform audit trail

Logs explain what software did. Audit explains what privileged people changed.

Audit every developer action involving:

- shop access;
- support sessions;
- plugin creation/edit/publish/withdraw;
- migration upload;
- pricing changes;
- entitlement grants/revocations;
- shop suspension/reactivation;
- worker retries/cancellations;
- sensitive log reveal;
- platform role changes.

Each audit entry records:

- actor;
- action;
- target type and ID;
- organization, if applicable;
- before and after state;
- reason;
- ticket/reference;
- IP/session/device context where permitted;
- timestamp;
- success/failure.

Audit entries are append-only and cannot be edited from the dashboard.

---

## 11. Support sessions and impersonation

Avoid silent impersonation.

If support must see the shop UI:

1. The operator requests a support session.
2. They provide a reason and ticket/reference.
3. The server issues a short-lived, shop-scoped support grant.
4. The shop UI displays a persistent **Support session** banner.
5. Destructive actions are disabled by default.
6. Every read and write is correlated to the support session.
7. The session expires automatically and can be terminated immediately.

Prefer read-only “view as shop” over full impersonation. Never use or reveal the owner’s credentials.

---

## 12. Control-plane data model

Suggested tables, separate from tenant business tables:

```text
platform_users
platform_roles
platform_permissions
platform_user_roles

plugin_packages
plugin_versions
plugin_version_permissions
plugin_version_migrations
plugin_version_assets
plugin_release_channels
plugin_prices
shop_plugin_entitlements
plugin_rollouts

platform_log_events
worker_jobs
worker_attempts
platform_incidents
support_sessions
platform_audit_log
```

Important properties:

- plugin version rows are immutable after publication;
- migration checksums are immutable;
- entitlement history is appendable/auditable;
- logs are partitioned by time at scale;
- cross-tenant endpoints use explicit platform authorization;
- service credentials never enter frontend bundles.

The existing tenant `plugins`, `plugin_migrations` and `plugin_data` tables remain the shop installation state. The control plane manages package publication and entitlement; it does not replace tenant state.

---

## 13. Server API design

The browser should call dedicated control-plane endpoints. Representative operations:

```text
GET  /developer/summary
GET  /developer/shops
GET  /developer/shops/:id
GET  /developer/shops/:id/health
GET  /developer/shops/:id/plugins
GET  /developer/shops/:id/logs
POST /developer/shops/:id/support-sessions
POST /developer/shops/:id/plugins/:key/validate
POST /developer/shops/:id/plugins/:key/retry-install

GET  /developer/plugins
POST /developer/plugins
GET  /developer/plugins/:key
POST /developer/plugins/:key/versions
POST /developer/plugins/:key/versions/:version/validate
POST /developer/plugins/:key/versions/:version/publish
POST /developer/plugins/:key/versions/:version/withdraw

GET  /developer/logs
GET  /developer/workers
POST /developer/workers/:id/retry
POST /developer/workers/:id/cancel
GET  /developer/audit
```

Every endpoint must:

- authenticate the user;
- check a platform permission;
- validate environment and target;
- return a correlation ID;
- redact sensitive data;
- write audit for privileged actions;
- apply pagination and bounded date ranges;
- use rate limits appropriate to the operation.

---

## 14. Frontend architecture

Keep the existing stack:

- Vanilla TypeScript;
- Vite;
- Tailwind;
- Material Symbols Rounded;
- Font Awesome where needed;
- History API routing;
- repository contracts;
- functions returning `HTMLElement`;
- no React, Vue or Nuxt.

Suggested source structure:

```text
src/
  developer/
    bootstrap.ts
    router.ts
    state/
      developer-session.ts
      environment.ts
    repositories/
      contracts.ts
      control-plane.ts
    layout/
      developer-shell.ts
      developer-navigation.ts
    features/
      overview/
      shops/
      shop-detail/
      plugins/
      plugin-editor/
      workers/
      logs/
      audit/
      access/
```

The generic login card and generic UI components may be shared. Shop feature modules and developer feature modules must not import each other’s internals.

Recommended boundary rules:

- `developer/` must not import from `features/pos`, `features/sales` or other tenant feature internals;
- tenant plugins must never import from `developer/`;
- generic components remain business-ignorant;
- control-plane repositories are the only browser code that knows developer APIs;
- no direct service-role Supabase client exists in `src/`.

---

## 15. Error, loading and empty states

Every developer screen must distinguish:

- no data;
- no permission;
- shop not found;
- shop suspended;
- stale client/server contract;
- partial telemetry outage;
- plugin package missing from the current bundle;
- plugin installation failed;
- worker delayed versus worker failed;
- sensitive payload withheld.

A red badge without an explanation and next action is not sufficient.

All long operations should show:

- current stage;
- target shop/plugin/version;
- whether cancellation is safe;
- correlation ID;
- final outcome and audit link.

---

## 16. Notifications and incident workflow

Developers may subscribe to:

- plugin install failure spikes;
- worker timeout/error thresholds;
- outbox lag;
- offline replay backlog;
- incompatible client versions;
- failed production migrations;
- authentication anomalies;
- paid entitlement inconsistencies.

An incident record should include:

- severity;
- status;
- affected shops/plugins/versions;
- owner;
- timeline;
- linked logs;
- mitigation;
- customer communication state;
- resolution and postmortem.

---

## 17. Accessibility and responsive behavior

- Full keyboard navigation
- Visible focus indicators
- Screen-reader labels for status and icon buttons
- Non-color status indicators
- Minimum 40–44 px touch targets
- Tables switch to horizontal scroll or cards on narrow screens
- Log JSON is readable and copyable without forcing page-wide horizontal overflow
- UTC/local timestamps include textual timezone labels
- Confirmation dialogs focus the safest action first

The dashboard is primarily desktop-oriented but must remain usable on a phone during an incident.

---

## 18. Delivery phases

### Phase A — Safe read-only control plane

- Shared login appearance
- Server-authorized developer session
- Separate developer shell/routes
- Overview
- Shops directory
- Shop profile and plugin state
- Read-only logs
- Platform audit reads

### Phase B — Plugin catalogue administration

- Plugin package editor
- Markdown documentation
- Free/paid pricing metadata
- Permission and settings-schema editors
- Version validation
- Release-candidate workflow

### Phase C — Controlled operations

- Publish/withdraw
- Shop entitlement management
- Safe install retry
- Worker retry/cancel
- Shop suspension
- Step-up authentication

### Phase D — Observability and rollout

- Structured telemetry ingestion
- Worker dashboards
- Alerting and incidents
- Staged plugin rollout
- Release health comparisons

### Phase E — Support sessions

- Short-lived read-only shop viewing
- Persistent support banner
- Full correlation and audit
- Explicit escalation for write access

---

## 19. Acceptance criteria

### Authentication and isolation

- A shop user cannot retrieve developer data by navigating directly to a developer route.
- No service-role or platform credential appears in a frontend bundle.
- An account with both access types can intentionally choose a workspace.
- Developer access is revoked server-side without waiting for a new deployment.

### Shops

- A developer can find a shop by name, slug or organization ID.
- The shop detail page identifies configuration, plugin state, client version and health without entering the POS.
- Sensitive fields remain masked without explicit permission.
- Every privileged shop action requires a reason and produces an audit entry.

### Plugins

- A developer can create a draft plugin with pricing, permissions, dependencies, settings schema and Markdown documentation.
- Invalid or non-namespaced permissions cannot be saved.
- A published migration cannot be changed without a checksum failure/new version.
- A release cannot be published without validation and approval.
- Free, trial, paid, installed and enabled states are displayed as separate facts.
- Disabling or withdrawing a plugin never silently deletes shop data.

### Logs and workers

- Logs can be filtered by shop, plugin, version, source, severity, outcome and correlation ID.
- Tokens, passwords, keys and payment secrets are redacted before storage.
- Worker detail shows attempts, timing, result and retry safety.
- Only idempotent jobs expose Retry.
- Viewing a sensitive payload is permission-gated and audited.

### Quality

- Typecheck, lint, boundary checks and tests pass.
- Control-plane repositories have contract tests.
- Permission-denial tests exist for every privileged endpoint.
- Cross-tenant tests prove one shop cannot be substituted for another.
- Production write actions have confirmation, reason, correlation ID and audit coverage.

---

## 20. Core design decision

The Developer Dashboard is a **separate control plane using the same design language and login experience**. It is not a hidden menu inside the shop dashboard.

That separation keeps the product understandable for shop staff and keeps cross-tenant power narrow, visible and auditable for developers.