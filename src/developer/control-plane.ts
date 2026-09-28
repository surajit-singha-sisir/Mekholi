import { getSupabase } from '../app/platform/supabase'

function client() {
  const value = getSupabase()
  if (!value) throw new Error('Mekholi is not connected to Supabase')
  return value
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message)
  if (result.data === null) throw new Error('The control plane returned no data')
  return result.data
}

export interface DeveloperSummary {
  shops: number
  shops_today: number
  users: number
  packages: number
  enabled_plugins: number
  plugin_errors: number
  error_logs_24h: number
  generated_at: string
}

export interface DeveloperShop {
  id: string
  name: string
  slug: string
  shop_type: string | null
  currency: string
  timezone: string
  created_at: string
  staff_count: number
  branch_count: number
  plugin_count: number
  has_plugin_error: boolean
  warehouse_count?: number
  register_count?: number
  status?: 'active' | 'suspended' | 'closed'
  locale?: string
  staff?: DeveloperStaff[]
  branches?: DeveloperBranch[]
  roles?: Array<{ id: string; key: string; name: string }>
  plugins?: Array<{ key: string; version: string; enabled: boolean; status: string; last_error: string | null }>
}

export interface DeveloperStaff {
  user_id: string
  email: string
  name: string | null
  active: boolean
  roles: Array<{ id: string; key: string; name: string; branch_id: string | null }>
}

export interface DeveloperBranch {
  id: string
  name: string
  code: string
  address: string | null
  phone: string | null
  email: string | null
  timezone: string | null
  is_primary: boolean
  deleted_at: string | null
}

export interface DeveloperUser {
  id: string
  email: string
  name: string | null
  created_at: string
  last_sign_in_at: string | null
  banned_until: string | null
  organization_count: number
  is_developer: boolean
}

export interface DeveloperPlugin {
  key: string
  name: string
  category: string
  version: string
  core_api_version: string
  description: string | null
  dependencies: string[]
  conflicts: string[]
  installed_shops: number
  enabled_shops: number
  error_shops: number
  permission_count: number
  migration_count: number
}

export interface DeveloperLog {
  id: string
  occurred_at: string
  severity: string
  source: string
  organization_name: string | null
  plugin_key: string | null
  action: string
  message: string
  correlation_id: string | null
  duration_ms: number | null
  outcome: string | null
  error_code: string | null
}

export const controlPlane = {
  async summary(): Promise<DeveloperSummary> {
    return unwrap(await client().rpc('developer_summary')) as DeveloperSummary
  },
  async shops(search = ''): Promise<DeveloperShop[]> {
    return unwrap(await client().rpc('developer_shops', { p_search: search || null, p_limit: 200 })) as DeveloperShop[]
  },
  async shop(id: string): Promise<DeveloperShop> {
    return unwrap(await client().rpc('developer_shop', { p_organization_id: id })) as DeveloperShop
  },
  async plugins(): Promise<DeveloperPlugin[]> {
    return unwrap(await client().rpc('developer_plugins')) as DeveloperPlugin[]
  },
  async logs(): Promise<DeveloperLog[]> {
    return unwrap(await client().rpc('developer_logs', { p_organization_id: null, p_plugin_key: null, p_limit: 200 })) as DeveloperLog[]
  },
  async users(search = ''): Promise<DeveloperUser[]> {
    return unwrap(await client().rpc('developer_users', { p_search: search || null, p_limit: 200 })) as DeveloperUser[]
  },
  async command<T = Record<string, unknown>>(action: string, payload: Record<string, unknown>): Promise<T> {
    return unwrap(await client().rpc('developer_command', { p_action: action, p_payload: payload })) as T
  },
  async startSupport(organizationId: string, reason: string, ticket = ''): Promise<{ id: string; expires_at: string }> {
    return unwrap(await client().rpc('developer_support_start', {
      p_organization_id: organizationId,
      p_reason: reason,
      p_ticket: ticket || null,
      p_minutes: 30,
    })) as { id: string; expires_at: string }
  },
  async endSupport(): Promise<{ ended: boolean; organization_id?: string }> {
    return unwrap(await client().rpc('developer_support_end')) as { ended: boolean; organization_id?: string }
  },
}
