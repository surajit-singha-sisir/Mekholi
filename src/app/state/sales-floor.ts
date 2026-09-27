/**
 * Where the user is selling right now.
 *
 * Branch, warehouse, register and open session are resolved once and shared,
 * because getting them out of step is the bug that shows up as a sale booked
 * against the wrong shop or stock decremented from the wrong room. Every
 * screen reads this; none of them re-derives it.
 *
 * The values are re-resolved when the organization changes and when a register
 * is opened or closed, both of which go through `refreshSalesFloor()`.
 */

import { Store } from './store'
import { sessionStore, activeOrganization } from './session'
import { getRepositories } from '../data'
import type { SalesFloor } from '../../shared/repositories/contracts'

export interface BranchOption {
  id: string
  name: string
  code: string | null
  is_primary: boolean
}

export interface SalesFloorState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  floor: SalesFloor | null
  /**
   * Every branch the user may sell from, resolved together with the floor.
   * Kept here so the switcher in the shell renders from state instead of
   * issuing its own query on every mount.
   */
  branches: BranchOption[]
  error: string | null
  /** Bumped on every successful resolve, so views can await a refresh. */
  generation: number
}

export const salesFloorStore = new Store<SalesFloorState>({
  status: 'idle',
  floor: null,
  branches: [],
  error: null,
  generation: 0,
})

// ── Branch choice ──────────────────────────────────────────────────────────
//
// The schema has been multi-branch since Phase 1 and the floor resolver
// silently sold from `branches[0]` the whole time — a shop's second branch
// existed in the database and nowhere else. The choice is per-user *and*
// per-organization (the same phone may run two shops), it survives a reload,
// and a stored id that no longer exists falls back rather than erroring: a
// deleted branch must not brick the till.

const BRANCH_KEY_PREFIX = 'mekholi.activeBranch.'

function storedBranchId(organizationId: string): string | null {
  try {
    return localStorage.getItem(BRANCH_KEY_PREFIX + organizationId)
  } catch {
    return null
  }
}

function storeBranchId(organizationId: string, branchId: string): void {
  try {
    localStorage.setItem(BRANCH_KEY_PREFIX + organizationId, branchId)
  } catch {
    /* private mode; the choice lasts the session via the store instead */
  }
}

/**
 * Which branch to sell from: the remembered one if it still exists, else the
 * primary, else the first. Pure, so the fallback order is a tested fact.
 */
export function chooseBranch(
  branches: readonly BranchOption[],
  preferredId: string | null
): BranchOption | undefined {
  if (preferredId) {
    const preferred = branches.find((branch) => branch.id === preferredId)
    if (preferred) return preferred
  }
  return branches.find((branch) => branch.is_primary) ?? branches[0]
}

let inflight: Promise<SalesFloor | null> | null = null

/**
 * Resolve the floor for the active organization.
 *
 * Concurrent callers share one request: the POS, the dashboard and the sidebar
 * badge all ask during boot, and three identical round trips would be three
 * chances to render a half-resolved screen.
 */
export async function refreshSalesFloor(): Promise<SalesFloor | null> {
  const organization = activeOrganization()
  if (!organization) {
    salesFloorStore.set({ status: 'idle', floor: null, error: null })
    return null
  }

  if (inflight) return inflight

  salesFloorStore.set({ status: 'loading', error: null })

  inflight = (async () => {
    try {
      const repos = getRepositories()
      const branches = await repos.organization.listBranches()
      const branch = chooseBranch(branches, storedBranchId(organization.organization_id))
      if (!branch) {
        salesFloorStore.set({
          status: 'error',
          floor: null,
          branches: [],
          error: 'This shop has no branches yet.',
        })
        return null
      }
      const floor = await repos.organization.salesFloor(branch.id)
      salesFloorStore.update((state) => ({
        status: 'ready',
        floor,
        branches,
        error: null,
        generation: state.generation + 1,
      }))
      return floor
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      salesFloorStore.set({ status: 'error', floor: null, branches: [], error: message })
      return null
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/**
 * Switch the branch the user sells from.
 *
 * Persists the choice, then re-resolves the whole floor — warehouse, register
 * and open session all hang off the branch, so they are re-derived together
 * rather than patched one by one. Everything that watches the store
 * (catalogue warmer, POS, dashboard) reacts the same way it does to an
 * organization switch.
 */
export async function setActiveBranch(branchId: string): Promise<SalesFloor | null> {
  const organization = activeOrganization()
  if (!organization) return null
  if (salesFloorStore.state.floor?.branchId === branchId) return salesFloorStore.state.floor
  storeBranchId(organization.organization_id, branchId)
  // Wait out a resolve already in flight so two floors never race each other.
  if (inflight) await inflight.catch(() => null)
  return refreshSalesFloor()
}

/** The floor, or null when it is not resolved yet. */
export function salesFloor(): SalesFloor | null {
  return salesFloorStore.state.floor
}

/** Re-resolve after an org switch. Wired to the session store once, at boot. */
export function watchOrganization(): () => void {
  return sessionStore.select(
    (state) => state.activeOrganizationId,
    () => {
      void refreshSalesFloor()
    }
  )
}
