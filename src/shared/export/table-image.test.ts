/**
 * The table-as-picture renderer, where a test runner can follow it.
 *
 * jsdom has no real 2D canvas, which is exactly the environment the
 * guard exists for: the renderer must resolve null — the caller's cue to
 * apologise — rather than throw or download an empty file. The drawing
 * itself is checked against a stub context that records calls, proving
 * every cell string reaches fillText and alignment follows the column.

 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { renderTableImage, type TableImageSpec } from './table-image'

const SPEC: TableImageSpec = {
  title: 'Due book (বাকির খাতা)',
  subtitle: '৳ 4,000.00 owed by 3 customer(s)',
  columns: [
    { label: 'Customer' },
    { label: 'Due', align: 'right' },
  ],
  rows: [
    ['Karim', '2,500.00'],
    ['Rahima', '1,000.00'],
  ],
  footer: 'Mekholi POS',
}

describe('renderTableImage', () => {
  it('resolves null where there is no drawable canvas (jsdom)', async () => {
    await expect(renderTableImage(SPEC)).resolves.toBeNull()
  })

  it('draws every cell through the platform text shaper when a canvas exists', async () => {
    const drawn: string[] = []
    const aligns: string[] = []
    const ctx = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      textBaseline: '',
      textAlign: 'left',
      scale: () => undefined,
      fillRect: () => undefined,
      strokeRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      measureText: (text: string) => ({ width: text.length * 7 }),
      fillText(text: string) {
        drawn.push(text)
        aligns.push(this.textAlign)
      },
    }
    const original = HTMLCanvasElement.prototype.getContext
    const originalBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.getContext = (() =>
      ctx as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
      callback(new Blob(['png'], { type: 'image/png' }))
    }
    try {
      const blob = await renderTableImage(SPEC)
      expect(blob).not.toBeNull()
      expect(drawn).toContain('Due book (বাকির খাতা)')
      expect(drawn).toContain('Karim')
      expect(drawn).toContain('2,500.00')
      expect(drawn).toContain('Mekholi POS')
      // The money column drew right-aligned; the name column left.
      expect(aligns[drawn.indexOf('2,500.00')]).toBe('right')
      expect(aligns[drawn.indexOf('Karim')]).toBe('left')
    } finally {
      HTMLCanvasElement.prototype.getContext = original
      HTMLCanvasElement.prototype.toBlob = originalBlob
    }
  })
})
