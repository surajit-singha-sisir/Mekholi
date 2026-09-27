/**
 * Code 128 — the barcode itself, as pure arithmetic.
 *
 * Written by hand rather than pulled in as a dependency for the same reason
 * `shared/export/csv.ts` was: the format is small, fixed since 1981, and the
 * failure mode of a wrong bar is silent — a scanner that reads nothing looks
 * like a broken scanner, and the shop blames the hardware it just bought.
 * Sixty lines of table and a checksum do not earn a package.
 *
 * Code 128 and not EAN-13, because a shop's own SKU is text (`RICE-5KG`),
 * and EAN encodes only digits it must also have paid GS1 for. Every laser
 * and camera scanner sold here reads Code 128; it is what courier labels and
 * supershop shelf labels already use.
 *
 * The module is pure: text in, module widths out. Rendering to SVG is a
 * separate function so the encoder can be tested as numbers — a test that
 * compared SVG markup would really be testing the serialiser.
 */

/**
 * The 107 symbol patterns, value → six bar/space widths (the stop pattern
 * has seven). Copied digit for digit from the ISO/IEC 15417 table; every
 * pattern sums to 11 modules, the stop to 13 — which `code128.test.ts`
 * asserts for the whole table, because one mistyped digit here is one
 * product the shop can never scan.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
] as const

const START_B = 104
const START_C = 105
const STOP = 106

/** True when the text can be encoded at all: printable ASCII, non-empty. */
export function code128Encodable(text: string): boolean {
  return text.length > 0 && [...text].every((ch) => {
    const code = ch.charCodeAt(0)
    return code >= 32 && code <= 126
  })
}

/**
 * Text → symbol values, checksum included.
 *
 * Two code sets are enough for a shop label: pure even-length digits go as
 * set C (half the width — a 13-digit code on a 38mm label needs it), and
 * everything else as set B. Mid-string set switching would save a few
 * modules on mixed SKUs and costs the exact kind of complexity this file
 * exists to avoid.
 */
export function code128Values(text: string): number[] {
  if (!code128Encodable(text)) {
    throw new Error('Code 128 can only carry printable ASCII, and at least one character.')
  }

  const values: number[] = []
  if (/^\d+$/.test(text) && text.length % 2 === 0) {
    values.push(START_C)
    for (let i = 0; i < text.length; i += 2) {
      values.push(Number(text.slice(i, i + 2)))
    }
  } else {
    values.push(START_B)
    for (const ch of text) values.push(ch.charCodeAt(0) - 32)
  }

  // The checksum: start value + Σ value × position, mod 103.
  let sum = values[0] as number
  for (let i = 1; i < values.length; i += 1) sum += (values[i] as number) * i
  values.push(sum % 103)
  values.push(STOP)
  return values
}

/**
 * Text → alternating bar/space widths in modules, bars first.
 * This is the barcode; everything after this is drawing.
 */
export function code128Widths(text: string): number[] {
  const widths: number[] = []
  for (const value of code128Values(text)) {
    for (const digit of PATTERNS[value] as string) widths.push(Number(digit))
  }
  return widths
}

export interface BarcodeSvgOptions {
  /** Bar height in local units. Default 40. */
  height?: number
  /** Width of one module. Default 1 — scale with CSS, not with this. */
  moduleWidth?: number
  /** Human-readable line under the bars. Default true. */
  showText?: boolean
}

/**
 * The barcode as an SVG string, quiet zones included.
 *
 * A string rather than a DOM node because the print sheet is written into a
 * blank window as one HTML document — and a string works in a vitest with no
 * DOM at all. The viewBox does the scaling: the same SVG prints at 38mm and
 * 50mm without re-encoding.
 */
export function code128Svg(text: string, options: BarcodeSvgOptions = {}): string {
  const { height = 40, moduleWidth = 1, showText = true } = options
  const widths = code128Widths(text)

  const QUIET = 10 * moduleWidth
  const totalModules = widths.reduce((sum, width) => sum + width, 0)
  const barsWidth = totalModules * moduleWidth
  const textBlock = showText ? 10 : 0
  const width = barsWidth + QUIET * 2
  const total = height + textBlock

  let x = QUIET
  let bar = true
  const rects: string[] = []
  for (const w of widths) {
    const rectWidth = w * moduleWidth
    if (bar) {
      rects.push(`<rect x="${x}" y="0" width="${rectWidth}" height="${height}" fill="#000"/>`)
    }
    x += rectWidth
    bar = !bar
  }

  const label = showText
    ? `<text x="${width / 2}" y="${height + 8}" text-anchor="middle" font-family="monospace" font-size="8" fill="#000">${escapeXml(text)}</text>`
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${total}" ` +
    `preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeXml(text)}">` +
    `<rect width="${width}" height="${total}" fill="#fff"/>${rects.join('')}${label}</svg>`
  )
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Exported for the table-integrity test only. */
export const CODE128_PATTERNS = PATTERNS
