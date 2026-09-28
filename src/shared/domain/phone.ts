/**
 * Phone numbers (§19).
 *
 * A customer's phone is mandatory — it is how the shop calls about a due, a
 * warranty, a delivery — so it has to be checked somewhere honest, once, and
 * the same way everywhere a customer is written down.
 *
 * Bangladeshi mobiles are normalized to the 11-digit `01…` form the shop
 * actually dials, whichever way it was typed (+880, 880, bare 1…). Anything
 * else sane — 6 to 15 digits, optional leading + — passes through untouched,
 * because not every customer of every shop carries a BD SIM.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.trim().replace(/[\s()./-]/g, '')
  if (!/^\+?\d{6,15}$/.test(digits)) return null
  const bd = digits.match(/^(?:\+?880|0)?(1\d{9})$/)
  return bd ? `0${bd[1]}` : digits
}
