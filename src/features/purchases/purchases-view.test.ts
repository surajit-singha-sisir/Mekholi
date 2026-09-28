import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('purchase order product picker', () => {
  it('settles with the selected product before modal close reports cancellation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/purchases/purchases-view.ts'), 'utf8')
    const handler = source.slice(source.indexOf('// Resolve the selected product before closing'), source.indexOf('// Resolve the selected product before closing') + 500)

    expect(handler.indexOf('finish({ product })')).toBeGreaterThan(-1)
    expect(handler.indexOf('dialog.close()')).toBeGreaterThan(handler.indexOf('finish({ product })'))
  })
})
