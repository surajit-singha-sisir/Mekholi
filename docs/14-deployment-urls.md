# 14 — Deployment URLs, OAuth returns, and the silent fallback

Written after a production Google sign-in landed on `http://localhost:5173`
with a live session in the URL. The code was not the cause, and the failure was
invisible from the app; this is the half of it that lives in the Supabase
dashboard, plus the hardening that makes the next occurrence harmless.

## 1. What happened

The app told GoTrue where to send the browser back to:

```
redirect_to=https://surajit-singha-sisir.github.io/Mekholi/
```

GoTrue checks that against **Authentication → URL Configuration → Redirect
URLs**. If it is not listed there, GoTrue does **not** fail — it quietly
substitutes the project's **Site URL**. With the Site URL still at its default
development value, the round trip finished on `http://localhost:5173`:

```text
http://localhost:5173/#access_token=eyJhbGciOiJFUzI1NiIs…#refresh_token=…#provider_token=…
```

Three things made that worse than a wrong page:

* the fragment held a **live session** — an access token good for an hour and a
  refresh token that mints new ones, sitting in the address bar of the wrong
  origin (and in history, and in anything the user pastes next);
* the session was valid, so the local dev server would happily sign the user in
  as themselves — a production session in a development environment;
* nothing in the app said anything, because nothing had errored.

The same substitution happens for local development in the other direction: a
Site URL pointing at production makes `localhost` returns land on production.

## 2. The dashboard settings (yours, not the code's)

No SQL and no migration can set these; they are project configuration.

**Supabase → Authentication → URL Configuration**

Production now runs on the custom domain `https://mekholipos.kehem.com` (served
at the root, not under a `/Mekholi/` sub-path). Use that as the Site URL. The
old GitHub Pages URL (`https://surajit-singha-sisir.github.io/Mekholi/`) can be
left in Redirect URLs if that host is still reachable, or removed once it is not.

| Field | Value |
|---|---|
| **Site URL** | `https://mekholipos.kehem.com` |
| **Redirect URLs** | `https://mekholipos.kehem.com/**` **and** `http://localhost:5173/**` (the `/**` wildcard lets the `?code=` return and deep links survive an OAuth return) |

The Site URL is the fallback, so it must be the *production* URL — the opposite
of the usual local-development convenience. Development is covered by listing
`localhost` in Redirect URLs, so it does not need to be the Site URL.

**Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client**

| Field | Value |
|---|---|
| Authorized redirect URI | `https://tjhodyveonlzabjaaino.supabase.co/auth/v1/callback` |

This one is already right if a sign-in ever reached Google and came back with
tokens — the callback goes to Supabase, not to the app. Supabase then forwards
to whatever `redirect_to` resolves to.

## 3. What the code does now

Nothing in the app can override the dashboard, but three changes mean the same
misconfiguration can no longer be silent or leak a session:

**PKCE instead of the implicit flow** (`src/app/platform/supabase.ts`).
`flowType: 'pkce'` makes the return carry a single-use `?code=` that the client
exchanges, instead of a session in the fragment. Verified against GoTrue: the
authorize request now carries `code_challenge_method=s256`. It also removes a
collision this app was always exposed to, because it routes on the fragment
(`#/pos`) and the implicit return *was* a fragment.

**The redirect URL is resolved from the page, not the origin**
(`src/app/platform/auth-url.ts`). The build uses `base: './'`, so `BASE_URL` is
relative; resolving `'./'` against `window.location.origin` would answer
`https://host/` and drop the `/Mekholi/` sub-path — sending production users to
the Pages root. It resolves against `window.location.href` instead, and the
sub-path case is covered by a test and by a probe served from `/Mekholi/`.

**The address bar is cleaned, always** (`consumeAuthCallback`, called from
`main.ts` in a `finally`). After the client has consumed the callback, anything
still in the URL — a leftover session from an implicit return, or an
`error_description` — is removed with `replaceState`, and a refusal is shown as
a toast instead of vanishing. It runs in `finally` because a stale session once
made `bootstrapSession` throw on the way, leaving the tokens in the URL: a token
left behind is worse than the error that caused it.

## 4. How to verify a deployment

1. Sign in with Google **from the deployed site** and watch the address bar: it
   should return to `https://mekholipos.kehem.com/` with no
   `access_token`, `refresh_token` or `code` in it.
2. `node node_modules/.scratch/oauth.mjs` (with `OAUTH_SITE` pointed at a local
   build) checks the four shapes without a Google account: PKCE on the authorize
   request, a session fragment stripped, a refusal reported, a route fragment
   untouched. It passes at the root and behind a `/Mekholi/` sub-path.
3. If a sign-in still lands on the wrong host, the cause is §2 — check the
   dashboard before the code.

## 5. If a session URL leaks

A refresh token in a URL is a credential. Treat it like a leaked password:

1. **Supabase → Authentication → Users → the account → Sign out all sessions.**
   That invalidates the refresh token; the leaked access token expires on its
   own within the hour.
2. **Google account → Security → Third-party apps** → remove the app if the
   `provider_token` was in the URL too (it is a Google access token with
   whatever scopes were granted).
3. It is not a reason to rotate the anon key: it is publishable by design, and
   RLS is what protects the data.
