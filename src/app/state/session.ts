/**
 * Session state and the client-side permission check (spec §42, §45).
 *
 * The permission matching below is a deliberate transcription of
 * `app.has_permission` in supabase/migrations/20260923_004_app_helpers.sql:
 *
 *     p.key = p_key
 *     OR p.key = '*'
 *     OR p.key = split_part(p_key, '.', 1) || '.*'
 *
 * The two must agree exactly, or the UI will offer an action that the
 * database refuses — or hide one the user is entitled to. Postgres is the
 * authority; this file exists to avoid rendering buttons that cannot work.
 */

import { Store } from './store'

/**
 * Mirrors the JSON returned by `app.session_payload()` in
 * supabase/migrations/20260923_019_session_payload.sql, plus `shop_type`
 * (047). Change one, change both.
 */
export interface OrganizationMembership {
  organization_id: string
  name: string
  slug: string
  currency: string
  timezone: string
  /**
   * The shop's business type — a key into `data/shop_categories.json`, e.g.
   * `pharmacy` or `mobile`. Null for a shop created before the wizard asked,
   * which the taxonomy treats as "no recommendations" rather than an error.
   */
  shop_type: string | null
  /** Display names, for the UI. */
  role_names: string[]
  /** Stable keys, for logic. `owner`, `admin`, `manager`, `cashier`, … */
  role_keys: string[]
  is_owner: boolean
  /**
   * Concrete keys with wildcards already expanded server-side. An owner holds
   * `sales.create`, not `*`, so the client needs only a Set lookup.
   */
  permissions: string[]
}

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'error'

export interface DeveloperAccess {
  enabled: boolean
  roles: string[]
  permissions: string[]
}

export interface SessionState {
  status: SessionStatus
  userId: string | null
  email: string | null
  organizations: OrganizationMembership[]
  activeOrganizationId: string | null
  /** Flattened permission keys from every role in the active organization. */
  permissions: string[]
  developer?: DeveloperAccess
  error: string | null
}

export const EMPTY_SESSION: SessionState = {
  status: 'loading',
  userId: null,
  email: null,
  organizations: [],
  activeOrganizationId: null,
  permissions: [],
  developer: { enabled: false, roles: [], permissions: [] },
  error: null,
}

export const sessionStore = new Store<SessionState>(EMPTY_SESSION)

/**
 * Wildcard-aware permission test.
 *
 *   can('sales.create')  with held `*`          → true   (owner)
 *   can('sales.refund')  with held `sales.*`    → true
 *   can('sales.refund')  with held `sales.create` → false
 *
 * An empty `required` is treated as "no permission needed" so nav items and
 * plugin-registered routes can omit the field entirely.
 */
export function matchesPermission(held: ReadonlySet<string>, required: string | undefined): boolean {
  if (!required) return true
  if (held.has('*')) return true
  if (held.has(required)) return true
  const resource = required.split('.')[0]
  if (!resource) return false
  return held.has(`${resource}.*`)
}

let permissionSet: ReadonlySet<string> = new Set()

sessionStore.select(
  (s) => s.permissions.join('|'),
  () => {
    permissionSet = new Set(sessionStore.state.permissions)
  }
)
// Seed the projection immediately; `select` only fires on change.
permissionSet = new Set(sessionStore.state.permissions)

/** The check every guard, sidebar item and button should call. */
export function can(required: string | undefined): boolean {
  return matchesPermission(permissionSet, required)
}

export function canAll(required: readonly (string | undefined)[]): boolean {
  return required.every((r) => can(r))
}

export function canAny(required: readonly (string | undefined)[]): boolean {
  return required.some((r) => can(r))
}

/** True when the caller belongs to at least one organization. */
export function hasOrganization(): boolean {
  return sessionStore.state.activeOrganizationId !== null
}

export function activeOrganization(): OrganizationMembership | undefined {
  const id = sessionStore.state.activeOrganizationId
  return sessionStore.state.organizations.find((o) => o.organization_id === id)
}
