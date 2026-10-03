# Security Policy

Mekholi is a point-of-sale platform. A vulnerability here can expose a shop's
takings, its customers' phone numbers and debts, or its staff's credentials.
We take reports seriously and we will not argue about severity before fixing
something.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through **[GitHub Security Advisories](https://github.com/surajit-singha-sisir/Mekholi/security/advisories/new)**,
which creates a private channel visible only to the maintainers.

Useful reports usually include:

- what the issue is, and which component (web app, database RPC, RLS policy,
  plugin, Android client, CI/deployment);
- the steps to reproduce it, ideally against a local `npm run dev` + a
  throwaway Supabase project rather than a live shop;
- what an attacker gets out of it — read access, write access, cross-tenant
  reach, privilege escalation, denial of service;
- anything you already know about affected versions or mitigations.

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 3 working days |
| Initial assessment and severity | 10 working days |
| Fix or documented mitigation — critical/high | 30 days |
| Fix or documented mitigation — medium/low | 90 days |

These are current targets for a small team, not a contractual SLA. If a report
stalls, say so on the advisory thread and it will be escalated.

We will credit you in the advisory unless you ask us not to. We do not operate
a paid bounty programme.

## Scope

**In scope**

- Cross-tenant data access — any path where one organization can read or write
  another's data. This is our highest-severity class.
- Privilege escalation between roles (cashier → manager → owner), or into the
  `platform_*` developer control plane.
- Authentication, session handling, and the staff invitation/creation flow.
- Row Level Security policy gaps, and `SECURITY DEFINER` functions that skip
  `app.require_org()` / `app.require_permission()`.
- Injection, XSS, or integrity flaws in the browser client.
- Supply-chain issues in dependencies that reach the shipped bundle.
- Flaws in the plugin boundary that let a plugin reach core or sibling
  plugin data.

**Out of scope**

- Vulnerabilities in build/dev tooling that do not execute in CI or ship to
  users. See the documented exceptions in `.github/workflows/ci.yml`.
- The Supabase anon/publishable key appearing in the browser bundle. This is
  public by design; RLS is the control. A way to get data *past* RLS with that
  key is very much in scope.
- Missing security response headers on the current GitHub Pages host. Known
  and tracked as **F-10** in `docs/21-enterprise-launch-audit-2026-10-03.md`;
  Pages cannot set headers at all.
- Findings that require a merchant's own device to be already compromised.
- Automated scanner output with no demonstrated impact.

## Known gaps

We would rather tell you than have you spend a weekend rediscovering them.
`docs/21-enterprise-launch-audit-2026-10-03.md` is a self-commissioned audit
listing 28 open findings, including several the project considers launch
blockers — no password recovery, no executing test of tenant isolation, no
production observability, and no security response headers.

If your finding is already in that document, a report confirming exploitability
with a working proof of concept is still valuable, because the audit asserts
these by inspection rather than by demonstration.

## Supported versions

The project is pre-1.0 and ships from `main`. Only the currently deployed
revision is supported; there are no maintained release branches.

## Handling credentials

If you believe a credential has been exposed — an API key, a database
password, a personal access token — report it privately and we will rotate
immediately. Please do not use a discovered credential beyond the minimum
needed to confirm that it works.
