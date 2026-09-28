/**
 * Authentication and session bootstrap (spec §41, §42).
 *
 * Two steps, deliberately separate:
 *   1. Supabase Auth establishes *who* the caller is.
 *   2. `app.session_payload()` establishes *what they may do*.
 *
 * Permissions are never inferred on the client from an email or a role label —
 * they are read from the database, where RLS enforces them anyway.
 */

import { getSupabase, isConfigured } from './supabase'
import { buildRedirectUrl } from './auth-url'
import { translateError } from './errors'
import { env } from '../env'
import { sessionStore, EMPTY_SESSION, type OrganizationMembership } from '../state/session'
import { eventBus } from '../../shared/bus'
import taxonomy from '../../../data/shop_categories.json'

interface ShopTypeTaxonomy {
  id: string
  recommends?: { categories?: string[] }
}

const SHOP_TYPES = (taxonomy as { categories: { children?: ShopTypeTaxonomy[] }[] }).categories.flatMap(
  (group) => group.children ?? []
)

export type AuthResult = { ok: true } | { ok: false; error: string; retryable: boolean }

/**
 * What this auth server does with a brand-new email sign-up.
 *
 * Project-level, not app-level: whether a new account must click a link before
 * it can sign in is a Supabase setting, and the client has no business
 * guessing. When confirmation is on, an email sign-up cannot reach the app —
 * the account is created, no session is issued, and (on the default Supabase
 * mailer, which is rate-limited and cannot deliver to arbitrary addresses) the
 * confirmation email usually never arrives. The shopkeeper is left with an
 * account they cannot use, and the email address is now burned for a retry.
 *
 * Reading the setting lets the sign-up screen say that up front instead of
 * producing a stranded account. `/auth/v1/settings` is a public endpoint —
 * the publishable key is all it needs — and `mailer_autoconfirm` is the flag
 * the dashboard's "Confirm email" switch controls.
 */
export interface AuthSettings {
  /** The server confirms new email sign-ups itself: no inbox round trip. */
  mailerAutoconfirm: boolean
  /** Password sign-up is open at all. */
  signupDisabled: boolean
}

let settingsRequest: Promise<AuthSettings | null> | null = null

/**
 * Cached: settings change by a dashboard edit, not during a session, and the
 * sign-up screen asks on every render.
 *
 * Returns null when the answer is unknown (offline, blocked, not configured).
 * Callers must treat null as "carry on" — a failed preflight must never stop a
 * signup that would otherwise have worked.
 */
export function authSettings(): Promise<AuthSettings | null> {
  if (!settingsRequest) settingsRequest = fetchAuthSettings()
  return settingsRequest
}

/** Test seam. */
export function resetAuthSettings(): void {
  settingsRequest = null
}

async function fetchAuthSettings(): Promise<AuthSettings | null> {
  if (!isConfigured()) return null
  try {
    const response = await fetch(`${env.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: env.supabaseAnonKey },
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      mailer_autoconfirm?: boolean
      disable_signup?: boolean
    }
    return {
      mailerAutoconfirm: body.mailer_autoconfirm === true,
      signupDisabled: body.disable_signup === true,
    }
  } catch {
    return null
  }
}

/**
 * The one place the "email confirmation is still on" instruction is written.
 *
 * It names the exact dashboard path, because this is the difference between a
 * shopkeeper signing up in thirty seconds and giving up: the setting is two
 * clicks away, and nothing in the app's own error message would ever say so.
 */
export const EMAIL_CONFIRMATION_SETTING_HINT =
  'turn off "Confirm email" in Supabase → Authentication → Sign In / Providers → Email'

/** The shape returned by `app.session_payload()`. */
interface SessionPayload {
  user_id: string | null
  organizations: OrganizationMembership[]
}

/**
 * GoTrue errors carry an HTTP status and a string code, not a Postgres code,
 * so they get their own translation. The rate-limit case deserves special
 * treatment because the raw message ("For security purposes…") never tells a
 * shopkeeper that the real fix is a setting on the server.
 */
function translateAuthError(error: unknown): string | null {
  const record = error as { code?: string; message?: string; status?: number; name?: string }
  const raw = typeof record?.message === 'string' ? record.message : ''

  if (record?.status === 429 || record?.code === 'over_email_send_rate_limit') {
    return (
      'Supabase is rate-limiting confirmation emails right now. ' +
      'Disable "Confirm email" under Authentication → Sign In / Providers → Email ' +
      'in the Supabase dashboard, then try again.'
    )
  }
  if (record?.code === 'email_address_invalid') {
    return 'That email address was rejected by the auth server. Use a real, deliverable address.'
  }
  if (record?.code === 'user_already_exists' || /already registered/i.test(raw)) {
    return 'An account with that email already exists. Sign in instead, or use a different email.'
  }
  if (record?.code === 'email_not_confirmed' || /email not confirmed/i.test(raw)) {
    return (
      'That account exists but was never confirmed. Confirm it once, or ' +
      `${EMAIL_CONFIRMATION_SETTING_HINT} — then sign in again.`
    )
  }
  return null
}

function fail(error: unknown): AuthResult {
  const specific = translateAuthError(error)
  const translated = translateError(error)
  console.error('[auth]', translated.code, error)
  return {
    ok: false,
    error: specific ?? translated.message,
    retryable: translated.retryable,
  }
}

/**
 * Restore a persisted session on load, or fall to `anonymous`.
 * Also subscribes to Supabase's auth events so a token refresh or a sign-out
 * in another tab updates the shell without a reload.
 */
export async function bootstrapSession(): Promise<void> {
  const supabase = getSupabase()
  if (!supabase) {
    sessionStore.set({ ...EMPTY_SESSION, status: 'anonymous', error: 'not-configured' })
    return
  }

  try {
    const { data, error } = await supabase.auth.getSession()
    if (error) throw error

    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || session === null) {
        sessionStore.reset({ ...EMPTY_SESSION, status: 'anonymous' })
        return
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        void loadSessionPayload()
      }
    })

    if (!data.session) {
      sessionStore.set({ ...EMPTY_SESSION, status: 'anonymous' })
      return
    }
    await loadSessionPayload()
  } catch (error) {
    sessionStore.set({ ...EMPTY_SESSION, status: 'error', error: translateError(error).message })
  }
}

/**
 * Read organizations and permissions for the signed-in user and publish them.
 * Safe to call repeatedly; the store no-ops when nothing changed.
 */
export async function loadSessionPayload(): Promise<void> {
  const supabase = getSupabase()
  if (!supabase) {
    sessionStore.set({ ...EMPTY_SESSION, status: 'anonymous' })
    return
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()
  if (userError) throw userError
  if (!user) {
    sessionStore.set({ ...EMPTY_SESSION, status: 'anonymous' })
    return
  }

  // Claim any pending organization invitations before reading permissions. The
  // RPC only accepts the currently authenticated user, so the email address
  // never becomes a client-controlled membership grant.
  const { error: invitationError } = await supabase.rpc('accept_staff_invitations', {
    p_user_id: user.id,
  })
  if (invitationError) {
    // Keep existing shops sign-in compatible while migration 052 is being
    // rolled out. Once the function exists, every real error still blocks the
    // session rather than silently hiding an invitation failure.
    const message = typeof invitationError.message === 'string' ? invitationError.message : ''
    const missingInvitationRpc = invitationError.code === 'PGRST202' || /accept_staff_invitations/i.test(message)
    if (!missingInvitationRpc) throw invitationError
  }

  const [{ data, error }, developerResult] = await Promise.all([
    supabase.rpc('session_payload'),
    supabase.rpc('developer_session'),
  ])
  if (error) throw error

  const payload = normalizePayload(data)
  const activeId = chooseActiveOrganization(payload.organizations)
  const developerRaw = developerResult.error ? null : developerResult.data
  const developerRecord =
    typeof developerRaw === 'object' && developerRaw !== null
      ? (developerRaw as { enabled?: boolean; roles?: unknown; permissions?: unknown })
      : null

  sessionStore.set({
    status: 'authenticated',
    userId: user.id,
    email: user.email ?? null,
    organizations: payload.organizations,
    activeOrganizationId: activeId,
    permissions: permissionsFor(payload.organizations, activeId),
    developer: {
      enabled: developerRecord?.enabled === true,
      roles: Array.isArray(developerRecord?.roles) ? developerRecord.roles.filter((v): v is string => typeof v === 'string') : [],
      permissions: Array.isArray(developerRecord?.permissions) ? developerRecord.permissions.filter((v): v is string => typeof v === 'string') : [],
    },
    error: null,
  })

  if (activeId) {
    eventBus.emit('session.changed', { type: 'session.changed', data: { organization_id: activeId } })
  }
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const supabase = getSupabase()
  if (!supabase) return { ok: false, error: 'Mekholi is not connected to a server yet.', retryable: false }

  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (error) return fail(error)
    await loadSessionPayload()
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Sign in with Google.
 *
 * The browser navigates away to finish the OAuth round trip, so there is no
 * result to return: `bootstrapSession` picks the session up when Google
 * redirects back.
 *
 * `redirectTo` is where GoTrue is *told* to send the browser. It only honours
 * that when the URL is listed under Supabase → Authentication → URL
 * Configuration → Redirect URLs; when it is not, GoTrue does not fail — it
 * silently substitutes the project's Site URL. A Site URL still pointing at
 * `http://localhost:5173` therefore drops a signed-in production user into a
 * local dev server. If sign-in ever lands on the wrong host again, that
 * setting is the cause, not this call (docs/14).
 */
export async function signInWithGoogle(): Promise<void> {
  const supabase = getSupabase()
  if (!supabase) return
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: buildRedirectUrl(window.location.href, import.meta.env.BASE_URL) },
  })
  if (error) {
    console.error('[auth] google sign-in failed', error)
  }
}

export interface ProvisionInput {
  shopName: string
  shopType: string
}

/**
 * Provision a shop for the *signed-in* user.
 *
 * This is the recovery path for an account that exists but has no
 * organization — a signup whose provisioning step failed, a user invited
 * before their shop existed, or an OAuth sign-in for a brand-new account.
 * The database only allows provisioning for oneself (`p_owner_user_id` must
 * equal `auth.uid()`), so there is no way to call this for another user.
 */
export async function provisionShop(input: ProvisionInput): Promise<AuthResult> {
  const supabase = getSupabase()
  if (!supabase) return { ok: false, error: 'Mekholi is not connected to a server yet.', retryable: false }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { ok: false, error: 'You are not signed in.', retryable: false }

    const defaults = SHOP_TYPES.find((type) => type.id === input.shopType)?.recommends?.categories ?? []
    const { error } = await supabase.rpc('provision_organization', {
      p_owner_user_id: user.id,
      p_org_name: input.shopName.trim(),
      p_slug: slugify(input.shopName),
      p_shop_type: input.shopType,
      p_categories: defaults,
    })
    if (error) return fail(error)

    // Re-read the session payload so organizations and permissions appear
    // without a page reload; the onboarding guard re-evaluates on navigation.
    await loadSessionPayload()
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

export interface SignUpInput {
  name: string
  email: string
  password: string
  shopName: string
  shopType: string
}

/**
 * Create the auth user, then provision the organization.
 *
 * Provisioning is a single Postgres function so the shop arrives complete:
 * branch, stock location, register, six roles, owner membership, units and
 * payment methods. Doing it client-side would mean nine round trips and a
 * half-created shop if the connection dropped midway.
 */
export async function signUp(input: SignUpInput): Promise<AuthResult> {
  const supabase = getSupabase()
  if (!supabase) return { ok: false, error: 'Mekholi is not connected to a server yet.', retryable: false }

  const settings = await authSettings()
  if (settings && !settings.mailerAutoconfirm) {
    // Refuse *before* the account exists. Creating it and then reporting that
    // it cannot be used leaves a stranded user row (one of which is still in
    // this project) and burns the address: a retry with the same email is
    // rejected as already registered until the account is confirmed.
    return {
      ok: false,
      error:
        'This project still requires email confirmation, so a new email sign-up ' +
        `cannot get past this screen — and its confirmation email is usually never ` +
        `delivered. To sign up with email and password, ${EMAIL_CONFIRMATION_SETTING_HINT}. ` +
        'Or use "Continue with Google", which needs no confirmation.',
      retryable: false,
    }
  }

  try {
    const { data, error } = await supabase.auth.signUp({
      email: input.email.trim(),
      password: input.password,
      options: { data: { full_name: input.name.trim() } },
    })
    if (error) return fail(error)

    const user = data.user
    if (!user) {
      return {
        ok: false,
        error: 'Check your inbox to confirm your email, then sign in.',
        retryable: false,
      }
    }
    if (!data.session) {
      // Reached only when the preflight had no answer (offline, or the setting
      // changed mid-flight) and the server turned out to require confirmation
      // anyway. The account exists and is not signed in, so say exactly that —
      // including the two-click fix, because the mail may never arrive.
      return {
        ok: false,
        error:
          `Account created for ${input.email.trim()}, but this project requires email ` +
          `confirmation before signing in. Open the confirmation link (if it arrives) — ` +
          `or ${EMAIL_CONFIRMATION_SETTING_HINT} and sign in.`,
        retryable: false,
      }
    }

    // One provisioning path, shared with the onboarding screen.
    return provisionShop({ shopName: input.shopName, shopType: input.shopType })
  } catch (error) {
    return fail(error)
  }
}

export async function signOut(): Promise<void> {
  const supabase = getSupabase()
  sessionStore.reset({ ...EMPTY_SESSION, status: 'anonymous' })
  eventBus.clear()
  if (supabase) {
    try {
      await supabase.auth.signOut()
    } catch (error) {
      console.warn('[auth] sign-out request failed; local session cleared anyway', error)
    }
  }
}

/**
 * Switch the active organization. Permissions are swapped in place; the caller
 * is responsible for re-rendering, which it does by subscribing to the store.
 */
export function selectOrganization(organizationId: string): void {
  const org = sessionStore.state.organizations.find((o) => o.organization_id === organizationId)
  if (!org) return
  sessionStore.set({
    activeOrganizationId: organizationId,
    permissions: org.permissions,
  })
  eventBus.emit('session.changed', {
    type: 'session.changed',
    data: { organization_id: organizationId },
  })
}

/**
 * A user with no organization has signed up but not provisioned — the router
 * sends them to onboarding rather than to a dashboard with nothing in it.
 */
export function needsOnboarding(): boolean {
  const s = sessionStore.state
  return s.status === 'authenticated' && s.organizations.length === 0
}

// ── Helpers ───────────────────────────────────────────────────────────────

function normalizePayload(data: unknown): SessionPayload {
  if (typeof data !== 'object' || data === null) {
    return { user_id: null, organizations: [] }
  }
  const record = data as Partial<SessionPayload>
  const organizations = Array.isArray(record.organizations) ? record.organizations : []
  return {
    user_id: record.user_id ?? null,
    organizations: organizations.map(normalizeMembership),
  }
}

function normalizeMembership(raw: Partial<OrganizationMembership>): OrganizationMembership {
  return {
    organization_id: raw.organization_id ?? '',
    name: raw.name ?? 'Unnamed shop',
    slug: raw.slug ?? '',
    currency: raw.currency ?? 'BDT',
    timezone: raw.timezone ?? 'Asia/Dhaka',
    shop_type: raw.shop_type ?? null,
    role_names: Array.isArray(raw.role_names) ? raw.role_names : [],
    role_keys: Array.isArray(raw.role_keys) ? raw.role_keys : [],
    is_owner: raw.is_owner === true,
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    is_support_session: raw.is_support_session === true,
    support_session_id: raw.support_session_id ?? null,
    support_expires_at: raw.support_expires_at ?? null,
  }
}

function chooseActiveOrganization(organizations: OrganizationMembership[]): string | null {
  if (organizations.length === 0) return null
  const stored = storedActiveOrganization()
  if (stored && organizations.some((o) => o.organization_id === stored)) return stored
  // Owners first: the person who created the shop is usually the one signing in.
  const owner = organizations.find((o) => o.is_owner)
  return (owner ?? organizations[0])?.organization_id ?? null
}

function permissionsFor(
  organizations: OrganizationMembership[],
  activeId: string | null
): string[] {
  const org = organizations.find((o) => o.organization_id === activeId)
  return org ? [...org.permissions] : []
}

const ACTIVE_KEY = 'mekholi.activeOrganization'

function storedActiveOrganization(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function rememberActiveOrganization(organizationId: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, organizationId)
  } catch {
    /* storage unavailable — the choice simply will not persist */
  }
}

/** `Rahim's Corner Store` → `rahims-corner-store`. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  // A unique constraint collision is surfaced as a friendly message, so a
  // timestamp suffix is only a convenience for the common case.
  return slug === '' ? `shop-${Date.now().toString(36)}` : slug
}

export { isConfigured }
