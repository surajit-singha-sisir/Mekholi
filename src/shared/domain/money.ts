/**
 * Money and quantity arithmetic (spec §59, docs/09 #5).
 *
 * Every monetary value in Postgres is `numeric(14,2)` and every quantity is
 * `numeric(14,3)`. JavaScript has neither type — only IEEE-754 doubles, where
 * `0.1 + 0.2 === 0.30000000000000004`. A POS that accumulates line totals in
 * floats will disagree with its own database by a paisa here and there, and
 * the disagreement grows with volume.
 *
 * So this module never stores money as a float. Money is an **integer count of
 * minor units** (poisha) and quantity is an **integer count of milli-units**.
 * Every intermediate is an integer; rounding happens once, at the same points
 * the database rounds, with the same rule.
 *
 * The brand types exist because "3" is ambiguous in a POS — it could be three
 * poisha, three taka or three kilograms. Mixing them is the single most common
 * money bug, and it is invisible until a customer complains. The compiler
 * catches it instead.
 */

/** Integer minor units: 100 = one whole of the currency (100 poisha = ৳1). */
export type Minor = number & { readonly __minor: unique symbol }

/** Integer milli-units: 1000 = one whole unit (1500 = 1.5 kg). */
export type Milli = number & { readonly __milli: unique symbol }

/**
 * Postgres `round(numeric, int)` rounds **half away from zero**, not half to
 * even. `round(2.5) = 3` and `round(-2.5) = -3`. Using `Math.round` (which
 * rounds half toward +∞) would diverge on negative halves — a refund line.
 */
export function roundHalfAway(value: number): number {
  if (!Number.isFinite(value)) return 0
  const sign = value < 0 ? -1 : 1
  // Adding a tiny epsilon guards against binary representation landing just
  // under .5 for a value that is exactly .5 in decimal (e.g. 1.005 * 100).
  const shifted = Math.abs(value) + Number.EPSILON * Math.abs(value)
  return sign * Math.floor(shifted + 0.5)
}

/** Round a fractional minor amount to a whole poisha, Postgres-style. */
export function toMinor(value: number): Minor {
  return roundHalfAway(value) as Minor
}

/** Brand an already-integral minor count. Truncates rather than rounds. */
export function minor(value: number): Minor {
  return Math.trunc(value) as Minor
}

/** Brand an already-integral milli count. */
export function milli(value: number): Milli {
  return Math.trunc(value) as Milli
}

const ZERO = 0 as Minor
export const ZERO_MINOR: Minor = ZERO

/**
 * Parse a user- or database-supplied money value into minor units.
 *
 * Accepts a number, a Postgres numeric rendered as text (`"1250.00"`), or
 * free-form user input (`"1,250"`, `" ৳1250.5 "`). Returns null for anything
 * that is not a finite non-negative amount — a money field is never NaN.
 */
export function parseMinor(input: string | number | null | undefined): Minor | null {
  if (input === null || input === undefined || input === '') return null
  const text = westernDigits(typeof input === 'number' ? String(input) : input)
  const cleaned = text.replace(/[^0-9.-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const value = Number.parseFloat(cleaned)
  if (!Number.isFinite(value)) return null
  return toMinor(value * 100)
}

/**
 * Parse a quantity into milli-units.
 *
 * When `isDecimal` is false the value is forced to a whole number: a shop
 * selling phones cannot sell 0.5 of one, and letting the keyboard produce
 * that would create a stock balance the shop can never reconcile.
 */
export function parseMilli(
  input: string | number | null | undefined,
  options: { decimal?: boolean } = {}
): Milli | null {
  if (input === null || input === undefined || input === '') return null
  const text = westernDigits(typeof input === 'number' ? String(input) : input)
  const cleaned = text.replace(/[^0-9.-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const value = Number.parseFloat(cleaned)
  if (!Number.isFinite(value)) return null
  // Truncate the *value* for countable goods, not the scaled result: typing
  // "1.5" for a phone must give 1 unit, and truncating after scaling would
  // happily return 1.5 units because 1.5 × 1000 is already an integer.
  if (!options.decimal) return (Math.trunc(value) * 1000) as Milli
  return roundHalfAway(value * 1000) as Milli
}

/** Minor units back to a float, for display and for JSON payloads. */
export function minorToNumber(value: Minor): number {
  return value / 100
}

export function milliToNumber(value: Milli): number {
  return value / 1000
}

/** Render minor units as a fixed 2-decimal string, e.g. `"1250.00"`. */
export function minorToFixed(value: Minor): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const whole = Math.trunc(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}${whole}.${frac}`
}

export interface MoneyFormatOptions {
  currency?: string
  locale?: string
  /** Omit the currency symbol, e.g. inside a column already headed "৳". */
  symbol?: boolean
  /**
   * Force Western digits. Machine-bound output (CSV, JSON, an `<input value>`
   * that will be parsed back) must stay `1250.00` even when the shop is
   * reading Bangla, or the round trip loses the number.
   */
  digits?: 'locale' | 'latin'
  /**
   * Whether the display conversion (multi-currency plugin) may apply.
   * Default true — the whole point of a display currency is that every
   * amount the eye meets is in it. Pass false where the number must stay
   * in base currency: machine-bound output, or a field the user types
   * base-currency amounts back into.
   */
  convert?: boolean
}

/**
 * Which locale money formats in when the caller does not say.
 *
 * Domain code must stay pure — it cannot import the i18n module and read a
 * mutable "current language" out of it. So the direction is inverted: the
 * i18n layer *pushes* a provider in here at startup, and `formatMoney` asks
 * it. Untouched (in a test, in a worker) the answer is `en-BD`, exactly as
 * before.
 */
let localeProvider: () => string = () => 'en-BD'

export function setMoneyLocaleProvider(provider: () => string): void {
  localeProvider = provider
}

/** Test hook: back to the hard-coded default. */
export function resetMoneyLocaleProvider(): void {
  localeProvider = () => 'en-BD'
}

export function moneyLocale(): string {
  return localeProvider()
}

/**
 * A display conversion: the shop keeps its books in one currency but wants
 * its *eyes* in another — ৳1,400 on the ledger reading as $11.43 on the
 * screen. The database never hears about this; every stored value stays in
 * base-currency minor units, so switching back (or fixing a wrong rate) is
 * lossless.
 *
 * The same push-provider inversion as the locale above: domain code cannot
 * import a plugin, so the multi-currency plugin pushes a provider in here
 * and `formatMoney` asks it. Untouched, the answer is `null` and money
 * formats exactly as before — a shop without the plugin pays nothing.
 */
export interface DisplayConversion {
  /** ISO 4217 code of the currency the screen should show. */
  code: string
  /** Minor digits of that currency — 2 for USD, 0 for JPY, 3 for KWD. */
  decimals: number
  /**
   * How many base **major** units buy one display **major** unit.
   * `1 USD = 122.50 BDT` is `rate: 122.5` with BDT as base.
   */
  rate: number
}

let displayConversionProvider: () => DisplayConversion | null = () => null

export function setDisplayConversionProvider(provider: () => DisplayConversion | null): void {
  displayConversionProvider = provider
}

/** Back to no conversion — called by the plugin's dispose and by tests. */
export function resetDisplayConversionProvider(): void {
  displayConversionProvider = () => null
}

export function displayConversion(): DisplayConversion | null {
  return displayConversionProvider()
}

/**
 * Base minor units → display minor units, rounding once, Postgres-style.
 * Exposed so a screen can show the arithmetic it is about to apply
 * (`৳1,400 ÷ 122.50 = $11.43`) with exactly the digits formatMoney will use.
 */
export function convertToDisplayMinor(value: Minor, conversion: DisplayConversion): number {
  const scale = 10 ** conversion.decimals
  return roundHalfAway(((value / 100) * scale) / conversion.rate)
}

/** A conversion is usable only when its rate can survive a division. */
function usableConversion(conv: DisplayConversion | null, baseCode: string): DisplayConversion | null {
  if (!conv) return null
  if (!Number.isFinite(conv.rate) || conv.rate <= 0) return null
  if (conv.code.toUpperCase() === baseCode.toUpperCase()) return null
  return conv
}

/**
 * Format minor units for display: `৳1,250.00`.
 *
 * Grouping is applied by hand rather than via `Intl.NumberFormat` because the
 * Bangladeshi lakh/crore digit grouping (`1,25,000.00`) differs from the
 * Western grouping that `en-US` produces, and a shop in Dhaka expects the
 * former. `Intl` is still consulted for the currency symbol so the function
 * stays correct for other currencies.
 */
export function formatMoney(value: Minor, options: MoneyFormatOptions = {}): string {
  const { currency = 'BDT', locale = localeProvider(), symbol = true, digits = 'locale', convert = true } = options
  const conversion = usableConversion(convert ? displayConversionProvider() : null, currency)

  // What the eye sees: either the base minor units as stored (2 decimals,
  // always — every column is numeric(14,2)), or the converted count of the
  // display currency's own minor units, whose decimals it dictates.
  const shownCode = conversion ? conversion.code : currency
  const decimals = conversion ? conversion.decimals : 2
  const shownMinor = conversion ? convertToDisplayMinor(value, conversion) : value

  const sign = shownMinor < 0 ? '-' : ''
  const abs = Math.abs(shownMinor)
  const scale = 10 ** decimals
  const whole = Math.trunc(abs / scale)
  const grouped = groupIndian(whole)
  const raw = decimals > 0 ? `${grouped}.${String(abs % scale).padStart(decimals, '0')}` : grouped
  const prefix = symbol ? `${currencySymbol(shownCode, locale)}${NON_BREAKING_THIN_SPACE}` : ''
  const body = digits === 'latin' ? raw : localizeDigits(raw, locale)
  return `${sign}${prefix}${body}`
}

/** Format a quantity: whole units collapse (`3`), decimals stay (`1.250 kg`). */
export function formatQty(
  value: Milli,
  options: { decimal?: boolean; unitLabel?: string | undefined; digits?: 'locale' | 'latin'; locale?: string } = {}
): string {
  const { decimal = false, unitLabel, digits = 'latin', locale = localeProvider() } = options
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  let body: string
  if (decimal) {
    const whole = Math.trunc(abs / 1000)
    const frac = abs % 1000
    body = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`
  } else {
    body = String(roundHalfAway(abs / 1000))
  }
  const shown = digits === 'latin' ? body : localizeDigits(body, locale)
  return unitLabel ? `${sign}${shown}${NON_BREAKING_THIN_SPACE}${unitLabel}` : `${sign}${shown}`
}

/**
 * Rewrite `0-9` in the locale's own numerals: `1,250.00` → `১,২৫০.০০`.
 *
 * Grouping is done by hand above (lakh/crore), so `Intl.NumberFormat` is used
 * only as a *digit table*: format 0…9 once per locale and cache the mapping.
 * A locale whose numbering system is already Western costs one lookup and
 * returns the string untouched.
 */
export function localizeDigits(text: string, locale: string): string {
  const table = digitTable(locale)
  if (!table) return text
  return text.replace(/[0-9]/g, (d) => table[Number(d)] ?? d)
}

/**
 * The inverse of `localizeDigits`: any decimal numeral becomes `0-9`.
 *
 * A shopkeeper with a Bangla keyboard types `১২৫` into the price field, and
 * `Number.parseFloat` has never heard of `১`. Every Unicode decimal digit
 * sits at a fixed offset from its block's zero, so one table of zeros covers
 * Bengali, Devanagari, Arabic-Indic and the rest without a per-glyph map.
 */
export function westernDigits(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0000-\u007f]/.test(text)) return text
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const zero = DIGIT_ZEROS.find((base) => code >= base && code <= base + 9)
    out += zero === undefined ? char : String(code - zero)
  }
  return out
}

/** Code point of zero in the numeral blocks a Bangladeshi shop might meet. */
const DIGIT_ZEROS = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Persian/Urdu)
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0be6, // Tamil
  0x0e50, // Thai
  0xff10, // Fullwidth
]

const digitTables = new Map<string, readonly string[] | null>()

function digitTable(locale: string): readonly string[] | null {
  const cached = digitTables.get(locale)
  if (cached !== undefined) return cached
  let table: readonly string[] | null = null
  try {
    const format = new Intl.NumberFormat(locale, { useGrouping: false })
    const rendered = Array.from({ length: 10 }, (_, d) => format.format(d))
    // Only worth a mapping when the locale actually renders other numerals.
    table = rendered.some((glyph, d) => glyph !== String(d)) ? rendered : null
  } catch {
    table = null
  }
  digitTables.set(locale, table)
  return table
}

/** Bangladeshi / Indian digit grouping: `1234567` → `12,34,567`. */
export function groupIndian(whole: number): string {
  const digits = String(whole)
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3)
  // Everything left of the last three digits groups in *pairs* from the
  // right: 1,00,000 — not the Western 100,000.
  const pairs: string[] = []
  for (let end = rest.length; end > 0; end -= 2) {
    pairs.unshift(rest.slice(Math.max(0, end - 2), end))
  }
  return [...pairs, last3].join(',')
}

const NON_BREAKING_THIN_SPACE = '\u202f'

/** Currency symbol with a safe fallback when Intl cannot resolve it. */
export function currencySymbol(currency: string, locale = 'en'): string {
  const known = CURRENCY_SYMBOLS[currency.toUpperCase()]
  if (known) return known
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
    }).formatToParts(0)
    return parts.find((p) => p.type === 'currency')?.value ?? currency
  } catch {
    return currency
  }
}

/** Common Bangladeshi retail tender symbols; avoids an Intl round trip. */
export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  BDT: '৳',
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  PKR: '₨',
  NPR: 'रू',
  AED: 'د.إ',
  SAR: '﷼',
  MYR: 'RM',
}
