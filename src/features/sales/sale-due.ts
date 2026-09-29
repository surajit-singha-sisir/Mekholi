/**
 * What a sale still owes — the same rule the ledger uses.
 *
 * The due book (`app.sale_due`, migration 057) is deliberate about this: only a
 * *live* sale can carry a due. A COMPLETED, PARTIALLY_PAID or PARTIALLY_REFUNDED
 * sale owes whatever is left unpaid; a CANCELLED sale never sold anything and a
 * REFUNDED one was handed back, so both owe nothing at all.
 *
 * The Sales screen used to compute its "Due" as a blind `total − paid` on every
 * row, which invented a debt on cancelled holds and fully-refunded sales — a
 * figure that then disagreed with the due book. This is that arithmetic, moved
 * to one pure place so the screen reads the same as the ledger and a test can
 * pin the two together.
 */
import type { SaleStatus } from '../../shared/types/records'

/**
 * The only statuses that can leave money owed. Kept as a set so the check is a
 * membership test rather than a chain of `||`, and exported so a test can prove
 * it matches the server's list without importing the DOM.
 */
export const DUE_BEARING_STATUSES: ReadonlySet<SaleStatus> = new Set<SaleStatus>([
  'COMPLETED',
  'PARTIALLY_PAID',
  'PARTIALLY_REFUNDED',
])

/**
 * The unpaid remainder a sale still owes, in the same units it was given.
 *
 * Zero for a status that owes nothing (cancelled, refunded, draft, held), and
 * never negative — an overpayment is change given, not a debt the shop holds.
 */
export function saleDue(status: string, total: number, paid: number): number {
  if (!DUE_BEARING_STATUSES.has(status as SaleStatus)) return 0
  return Math.max(0, total - paid)
}
