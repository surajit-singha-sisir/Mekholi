import { describe, expect, it } from 'vitest'
import { chooseBranch, type BranchOption } from './sales-floor'

function branch(id: string, overrides: Partial<BranchOption> = {}): BranchOption {
  return { id, name: id.toUpperCase(), code: null, is_primary: false, ...overrides }
}

describe('chooseBranch', () => {
  const branches = [branch('a'), branch('b', { is_primary: true }), branch('c')]

  it('honours a remembered branch that still exists', () => {
    expect(chooseBranch(branches, 'c')?.id).toBe('c')
  })

  it('falls back to the primary when the remembered branch is gone', () => {
    // A deleted branch must not brick the till — the choice degrades, the
    // floor still resolves.
    expect(chooseBranch(branches, 'deleted')?.id).toBe('b')
  })

  it('falls back to the primary when nothing is remembered', () => {
    expect(chooseBranch(branches, null)?.id).toBe('b')
  })

  it('falls back to the first branch when none is primary', () => {
    expect(chooseBranch([branch('x'), branch('y')], null)?.id).toBe('x')
  })

  it('returns undefined for a shop with no branches', () => {
    expect(chooseBranch([], null)).toBeUndefined()
    expect(chooseBranch([], 'a')).toBeUndefined()
  })
})
