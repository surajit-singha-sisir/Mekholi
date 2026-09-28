/**
 * The point of sale (spec §14, §15, §17).
 *
 * ── The keyboard target ──────────────────────────────────────────────────
 * The acceptance test for Phase 2 is "a cashier completes a sale with keyboard
 * only, in under 10 keystrokes for a single-item cash sale." The flow this
 * screen implements, with the key count:
 *
 *     r i c          3   type to search (the field is focused on arrival)
 *     Enter          1   add the highlighted product
 *     F2             1   open payment — the amount field is pre-filled
 *     Enter          1   add the tender, which settles the sale
 *                    ─
 *                    6
 *
 * Everything else is reachable by mouse, but nothing requires it. That is a
 * deliberate asymmetry: a shop counter is a keyboard-and-scanner environment
 * and the mouse is for the exceptions.
 *
 * ── Where the truth lives ────────────────────────────────────────────────
 * Prices, tax and totals are *shown* here and *decided* by `complete_sale`.
 * The receipt is printed from what the RPC returned, not from this cart, so a
 * stale price in the browser cannot reach the customer's receipt.
 */

import { t } from '../../shared/i18n'
import { h, icon, mount } from '../../components/ui/h'
import { button, iconButton, spinner } from '../../components/ui/button'
import { badge, emptyState } from '../../components/ui/card'
import { toastError, toastSuccess, toastWarning } from '../../components/feedback/toast'
import { confirm } from '../../components/feedback/modal'
import { input } from '../../components/ui/input'
import { CartStore } from './cart-store'
import { SaleService, toCartLine } from './sale-service'
import { openPaymentDialog } from './payment-dialog'
import { openCustomerDialog } from './customer-dialog'
import { capabilities, loadDeviceSettings } from '../../shared/devices/device-config'
import { beep, listenForScans } from '../../shared/devices/scanner'
import { promptDeviceSetup } from '../devices'
import { openReceipt } from './receipt'
import { refreshSalesFloor, salesFloor, salesFloorStore } from '../../app/state/sales-floor'
import { activeOrganization, can } from '../../app/state/session'
import { getRepositories } from '../../app/data'
import {
  panelLines,
  pluginPanelsHost,
  posFieldValues,
  printableNotes,
  resolveScan,
  saleAdjustmentsHost,
  type AppliedAdjustment,
} from '../../app/plugin-slots'
import type { PluginRegistry } from '../../shared/registry/plugin-registry'
import type { EventBus } from '../../shared/bus/event-bus'
import type { SalesFloor, SellableProduct } from '../../shared/repositories/contracts'
import type {
  PanelContext as PluginPanelContext,
  SaleAdjustmentContext,
  SaleAdjustmentDefinition,
  SaleAdjustmentQuote,
  SaleAdjustmentRelease,
  ScanMatch,
} from '../../shared/registry/plugin-types'
import type { CustomerRow, SaleRow } from '../../shared/types/records'
import {
  formatMoney,
  formatQty,
  milli,
  minor,
  minorToNumber,
  parseMilli,
  type Milli,
  type Minor,
} from '../../shared/domain/money'
import { translateError } from '../../app/platform/errors'
import type { PaymentEntry } from '../../shared/domain/cart'

export interface PosViewOptions {
  bus: EventBus
  /** The plugin host: its panels are drawn beside the cart. */
  registry: PluginRegistry
  onNavigate?: (path: string) => void
}

export function posView(options: PosViewOptions): HTMLElement {
  const floor = salesFloor()
  // The floor resolve starts when the shell mounts, but the router can render
  // this route first — a bookmarked #/pos, or a fast tap after signing in. So
  // the gate below subscribes and swaps itself for the real screen; reading
  // the floor once and giving up produced a permanent hourglass, which is
  // indistinguishable from a broken app.
  return floor ? posScreen(options, floor) : posGate(options)
}

/**
 * Holds the POS until the sales floor is resolved.
 *
 * Deliberately loud on failure: the previous version said "The shop is still
 * loading" while the resolve had already failed, so a real error looked like
 * patience. A shopkeeper cannot act on an hourglass, and neither can support.
 */
function posGate(options: PosViewOptions): HTMLElement {
  const root = h('div', { class: 'h-full min-h-0' })
  let done = false

  const render = (): void => {
    if (done) return
    const state = salesFloorStore.state

    if (state.floor) {
      done = true
      unsubscribe()
      mount(root, posScreen(options, state.floor))
      return
    }

    if (state.status === 'error') {
      done = true
      unsubscribe()
      mount(
        root,
        emptyState('The shop could not be loaded', {
          description:
            (state.error ?? 'Unknown error') +
            ' — branch, stock room and register are needed before anything can be sold.',
          iconName: 'error',
          action: button('Try again', {
            variant: 'primary',
            onClick: () => {
              // Re-entering sets the gate back to its loading state rather
              // than leaving a dead "Try again" on screen.
              mount(root, posGate(options))
              void refreshSalesFloor()
            },
          }),
        })
      )
      return
    }

    mount(
      root,
      emptyState('Loading the shop…', {
        description: 'Branch, stock room and register.',
        iconName: 'hourglass_top',
      })
    )
  }

  const unsubscribe = salesFloorStore.subscribe(render)
  if (salesFloorStore.state.status === 'idle') void refreshSalesFloor()
  render()

  return root
}

/**
 * Catalogue columns, revealed as the till's screen can afford them. A counter
 * is as often a phone in portrait as it is a widescreen till.
 */
const POS_UNTIL_SM = 'sm:hidden'
const POS_AT_SM = 'hidden sm:table-cell'
const POS_AT_XL = 'hidden xl:table-cell'

function posScreen(options: PosViewOptions, floor: SalesFloor): HTMLElement {
  const { bus, registry } = options
  const organization = activeOrganization()
  const currency = organization?.currency ?? 'BDT'

  const repos = getRepositories()
  // The registry is handed in so plugins get their turn at `sale.complete`.
  const sales = new SaleService(repos, bus, registry)
  const cart = new CartStore(floor.branchId)

  // Two panes side by side on a till, one scrolling page on a phone.
  //
  // The phone case used to be the desktop case turned vertical: the screen
  // was pinned to the viewport and the cart was `shrink-0`, so the cart took
  // whatever height it wanted — all of it — and the catalogue above it was
  // squeezed to nothing while the cart's own content spilled past the clip.
  // A 390px portrait screen cannot hold a catalogue *and* a full cart at
  // once, so below `lg` neither is pinned: the page grows and the app's
  // outlet scrolls it, catalogue first, cart underneath.
  const root = h('div', { class: 'flex min-h-full flex-col lg:h-full lg:min-h-0 lg:flex-row' })

  // ── Left: catalogue ─────────────────────────────────────────────────────

  let results: SellableProduct[] = []
  let highlighted = 0
  // What the till has looked at this session, by variant: the receipt prints
  // plugin fields (`printable`) from here, because a sale line carries the
  // variant and nothing else about the product.
  const seen = new Map<string, SellableProduct>()
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Nothing is "selected" here in the usual sense.
   *
   * A row is ticked when — and only when — that product is on the current
   * sale. The tick is a *report* on the cart, not a second list kept beside
   * it, so the two can never disagree: remove a line from the sale and the
   * row unticks itself, because it is reading from the same place.
   */
  function lineFor(variantId: string): string | undefined {
    return cart.state.cart.lines.find((line) => line.variantId === variantId)?.lineId
  }

  // A table, not tiles: at a counter the cashier is answering questions —
  // "which pack size is this", "is that the 5kg", "have we got any left" —
  // and a 150px tile could only ever hold a name and a price.
  const grid = h('div', { class: 'grid' })

  const statusLine = h('p', { class: 'px-3 pb-1.5 text-xs text-content-subtle' })

  const searchField = input({
    type: 'search',
    leadingIcon: 'barcode_scanner',
    class: 'h-12 text-base',
    placeholder: 'Scan a barcode or type a product name — then Enter',
    autofocus: true,
    autocomplete: 'off',
    onInput: (value) => {
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => void runSearch(value), 150)
    },
  })

  searchField.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void onEnterInSearch()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      highlighted = Math.min(highlighted + 1, results.length - 1)
      renderResults()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      highlighted = Math.max(highlighted - 1, 0)
      renderResults()
    } else if (event.key === 'Escape') {
      searchField.value = ''
      void runSearch('')
    }
  })

  async function runSearch(term: string): Promise<void> {
    const trimmed = term.trim()

    // A scanner sends a full code followed by Enter, which arrives as one
    // input event. An exact barcode hit is unambiguous, so it is added
    // immediately rather than shown as a list of one.
    if (trimmed.length >= 6 && /^[0-9A-Za-z-]+$/.test(trimmed)) {
      const scanned = await repos.catalog.findByBarcode(trimmed, floor!.warehouseId)
      if (scanned) {
        addToCart(scanned)
        searchField.value = ''
        return
      }

      // The shop's barcodes did not know this code. An add-on might: a scale
      // label carries a PLU inside it, a prepaid card carries its own number.
      // The plugin decodes, and the *core* looks the result up in the same
      // barcode table — so an add-on can never ring up something the shop does
      // not sell (docs/11 §Scan resolvers).
      const recognised = await resolveScan(registry, trimmed, {
        organizationId: organization?.organization_id ?? '',
        branchId: floor!.branchId,
        warehouseId: floor!.warehouseId,
        currency,
      })
      if (recognised) {
        const product = await repos.catalog.findByBarcode(
          recognised.match.lookupCode,
          floor!.warehouseId
        )
        if (product) {
          addToCart(product, recognised.match)
          toastSuccess(recognised.match.note ?? `${recognised.label} · ${recognised.match.lookupCode}`)
          searchField.value = ''
          void runSearch('')
          searchField.focus()
          return
        }
        // The plugin understood the code and the shop cannot sell it: say so
        // plainly rather than showing an empty search result.
        statusLine.textContent =
          `${recognised.label} read that as ${recognised.match.lookupCode}, ` +
          'but no product in this shop carries that code.'
        return
      }
    }

    try {
      const page = await repos.catalog.searchProducts({
        search: trimmed,
        warehouseId: floor!.warehouseId,
        limit: 40,
      })
      results = page.items
      highlighted = 0
      renderResults()
    } catch (error) {
      toastError(translateError(error).message)
    }
  }

  async function onEnterInSearch(): Promise<void> {
    const product = results[highlighted]
    if (!product) return
    addToCart(product)
    searchField.value = ''
    await runSearch('')
    searchField.focus()
  }

  /**
   * Adds a product to the cart. `scan` is present when the line came from a code
   * an add-on recognised: it carries the weight that was on the label, so a
   * weighed line starts at 1.250 kg rather than at the till's whole-unit step.
   *
   * A price the label printed is *shown*, never charged. Every line is priced by
   * `complete_sale` from the catalogue, so a till whose screen disagreed with its
   * receipt would be worse than one that never read the label at all — a label
   * that disagrees becomes a warning the cashier can act on instead.
   */
  function addToCart(product: SellableProduct, scan?: ScanMatch): void {
    // One tap is one unit — 1, 2, 3 — whatever the product is measured in.
    // Fractions of a kilo arrive by typing them or by scanning a scale
    // label, never from the stepper: counting by quarters is how a till
    // surprises a cashier.
    const step: Milli = milli(1000)
    const line = toCartLine(product)
    if (scan) warnIfLabelPriceDiffers(product, scan)
    if (scan && scan.quantity !== undefined) {
      cart.add(line, milli(Math.round(scan.quantity * 1000)))
      return
    }
    cart.add(line, step)
  }

  /**
   * A stale shelf price is the one thing a scale label cannot tell us by itself:
   * the label was printed days ago, the shop changed the price yesterday, and the
   * customer is looking at the label. Say both numbers; the cashier deals with the
   * shelf, and the receipt still carries the shop's own price.
   */
  function warnIfLabelPriceDiffers(product: SellableProduct, scan: ScanMatch): void {
    if (scan.unitPriceMinor === undefined || scan.unitPriceMinor === product.price) return
    toastWarning(
      `${scan.note ?? 'That label'} says ${formatMoney(minor(scan.unitPriceMinor), { currency })}, ` +
        `but this shop charges ${formatMoney(product.price, { currency })}. ` +
        'Charging the shop’s price.'
    )
  }

  function renderResults(): void {
    if (results.length === 0) {
      statusLine.textContent = 'No products match.'
      grid.replaceChildren(
        h('div', { class: 'px-3 py-12 text-center' },
          icon('search_off', 'text-4xl text-content-subtle'),
          h('p', { class: 'mt-2 text-sm font-medium text-content', text: 'Nothing found' }),
          h('p', {
            class: 'mt-0.5 text-xs text-content-subtle',
            text: 'Check the spelling, or add the product first.',
          })
        )
      )
      return
    }
    statusLine.textContent = `${results.length} product${results.length === 1 ? '' : 's'}`
    grid.replaceChildren(
      // A counter tablet in portrait is narrower than these columns. The
      // catalogue keeps them and scrolls sideways rather than stacking the
      // price under the name.
      h('div', { class: 'w-full min-w-0 overflow-x-auto' },
      h('table', { class: 'w-max min-w-full table-auto text-sm' },
        h('thead', {
          class: 'bg-surface text-left text-xs text-content-muted shadow-[0_1px_0_0_var(--color-border)]',
        },
          h('tr', {},
            h('th', { class: 'w-10 px-3 py-2' }, selectAllBox()),
            h('th', { class: 'px-3 py-2 font-medium', text: 'Product' }),
            h('th', { class: `px-3 py-2 font-medium ${POS_AT_SM}`, text: 'SKU' }),
            h('th', { class: `px-3 py-2 font-medium ${POS_AT_XL}`, text: 'Category' }),
            h('th', { class: 'px-3 py-2 font-medium text-right', text: 'Price' }),
            h('th', { class: `px-3 py-2 font-medium text-right ${POS_AT_XL}`, text: 'Tax' }),
            h('th', { class: 'px-3 py-2 font-medium text-center', text: 'Stock' })
          )
        ),
        h('tbody', {}, ...results.map((product, index) => productRow(product, index)))
      )
      )
    )
  }

  /**
   * Tick-all for what the search just returned — the scope the cashier can
   * see, never the whole catalogue. Indeterminate when only some of the list
   * is on the sale, so the box reports the truth rather than rounding it.
   */
  function selectAllBox(): HTMLElement {
    const on = results.filter((product) => lineFor(product.variantId)).length
    const box = h('input', {
      type: 'checkbox',
      class: 'h-4 w-4 cursor-pointer rounded border-input text-primary focus:ring-2 focus:ring-ring',
      checked: on > 0 && on === results.length,
      'aria-label': 'Put every product listed on the sale',
    }) as HTMLInputElement
    box.indeterminate = on > 0 && on < results.length
    box.addEventListener('change', () => {
      for (const product of results) {
        const lineId = lineFor(product.variantId)
        if (box.checked && !lineId) addToCart(product)
        else if (!box.checked && lineId) cart.remove(lineId)
      }
      searchField.focus()
    })
    return box
  }

  /**
   * A tick puts the product on the sale; a second tick takes it off again.
   *
   * Removing is the whole reason the row is a toggle rather than a button: a
   * cashier who taps the wrong line is standing in front of a customer, and
   * tapping it again is a shorter apology than hunting for the line in the
   * cart and finding its bin icon.
   */
  function toggleOnSale(product: SellableProduct): void {
    const lineId = lineFor(product.variantId)
    if (lineId) cart.remove(lineId)
    else addToCart(product)
    searchField.focus()
  }

  function productRow(product: SellableProduct, index: number): HTMLElement {
    seen.set(product.variantId, product)
    const out =
      product.trackStock &&
      !product.allowNegative &&
      product.availableQty !== null &&
      product.availableQty <= 0
    const onSale = lineFor(product.variantId) !== undefined

    const box = h('input', {
      type: 'checkbox',
      class: 'h-4 w-4 cursor-pointer rounded border-input text-primary focus:ring-2 focus:ring-ring',
      checked: onSale,
      'aria-label': `Put ${product.name} on the sale`,
    }) as HTMLInputElement
    box.addEventListener('click', (event) => event.stopPropagation())
    box.addEventListener('change', () => toggleOnSale(product))

    return h('tr', {
      class: [
        'cursor-pointer border-b border-border transition-colors',
        onSale
          ? 'bg-primary/10 hover:bg-primary/15'
          : index === highlighted
            ? 'bg-primary/5'
            : 'hover:bg-surface-muted',
        out ? 'opacity-70' : '',
      ].filter(Boolean).join(' '),
      'data-variant': product.variantId,
      'aria-selected': onSale ? 'true' : 'false',
      // The whole row is the target. A 16px checkbox is a poor thing to ask a
      // thumb to hit across a counter.
      onClick: () => toggleOnSale(product),
    },
      h('td', { class: 'px-3 py-2' }, box),
      h('td', { class: 'px-3 py-2' },
        h('div', { class: 'flex items-center gap-2.5' },
          product.imageUrl
            ? h('img', {
                src: product.imageUrl,
                alt: '',
                loading: 'lazy',
                class: 'h-9 w-9 shrink-0 rounded-md border border-border object-cover aspect-square',
              })
            : h('div', {
                class: 'grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-surface-muted text-content-subtle',
              }, icon('inventory_2', 'text-base')),
          h('div', { class: 'min-w-0' },
            h('p', { class: 'truncate font-medium leading-tight text-content', text: product.name, title: product.name }),
            product.variantName
              ? h('p', { class: 'text-xs text-content-muted', text: product.variantName })
              : null,
            // Narrow tills drop the SKU column; it belongs with the name there.
            h('p', {
              class: `font-mono text-[11px] text-content-subtle ${POS_UNTIL_SM}`,
              text: product.sku ?? '',
            }),
            // Plugin-registered fields (spec §14) — a batch or an expiry the
            // cashier can act on before ringing up.
            ...posFieldValues(registry, product.metadata).map((entry) =>
              h('p', { class: 'text-[11px] text-content-subtle', text: entry.text })
            )
          )
        )
      ),
      h('td', { class: `px-3 py-2 font-mono text-xs text-content-muted ${POS_AT_SM}`, text: product.sku ?? '—' }),
      h('td', { class: `px-3 py-2 text-content-muted ${POS_AT_XL}`, text: product.categoryName ?? '—' }),
      h('td', { class: 'px-3 py-2 text-right' },
        h('span', {
          class: 'font-semibold tabular-nums text-content',
          text: formatMoney(product.price, { currency }),
        }),
        product.unitLabel
          ? h('span', { class: 'text-xs text-content-subtle', text: ` /${product.unitLabel}` })
          : null
      ),
      h('td', { class: `px-3 py-2 text-right text-xs tabular-nums text-content-subtle ${POS_AT_XL}`,
        text: product.taxRatePercent > 0
          ? `${product.taxRatePercent}%${product.taxInclusive ? ' incl.' : ''}`
          : '—',
      }),
      h('td', { class: 'px-3 py-2 text-center' },
        product.trackStock
          ? h('span', {
              // A stock figure a cashier can read at arm's length: quiet when
              // there is stock, loud when there is none.
              class: `inline-block rounded px-1.5 py-0.5 text-[11px] tabular-nums ${
                out ? 'bg-danger/10 font-medium text-danger' : 'bg-surface-muted text-content-subtle'
              }`,
              text: formatQty(product.availableQty ?? milli(0), { decimal: product.decimalQuantity }),
            })
          : h('span', { class: 'text-xs text-content-subtle', text: '—' })
      ),
    )
  }

  // ── Right: cart ─────────────────────────────────────────────────────────

  /**
   * Who is buying. The cart has carried a customer id since the first commit
   * and nothing ever set it, so every sale was a walk-in and no add-on could be
   * about the person at the counter (spec §19).
   */
  /**
   * Everyone the cashier has put on this sale.
   *
   * It is a list because a counter is not always one person — a company buyer
   * with the person collecting, a parent paying for a child's account — and the
   * cashier should be able to name them all without a second screen. The
   * server stores one customer per sale, so the **first** chip is the one the
   * sale is billed to; removing it promotes the next.
   */
  let attachedCustomers: CustomerRow[] = []

  const customerLine = h('div', {
    class: 'border-b border-border px-3 py-1.5',
  })

  // `overflow-x-hidden` is deliberate: a container with `overflow-y-auto`
  // computes `overflow-x: auto`, so one too-wide child used to hand the whole
  // cart a horizontal scrollbar. Nothing in a cart is ever meant to be read
  // sideways.
  const lineList = h('div', {
    // On a phone the list is as tall as the sale is long and the page
    // scrolls; only the desktop rail scrolls its lines internally.
    class: 'overflow-x-hidden px-2.5 py-2 space-y-1.5 lg:flex-1 lg:min-h-0 lg:overflow-y-auto',
  })
  // Money a plugin has taken off this sale, and the strip the cashier applies it
  // from. The till owns this list, not the plugin: the *sum* is what reaches
  // `complete_sale`, and a plugin that lost track of its own quote can be told.
  let appliedAdjustments: AppliedAdjustment[] = []
  const adjustmentsSlot = h('div', { class: 'px-3' })
  const totalsBox = h('div', { class: 'border-t border-border px-3 py-2.5 space-y-1.5' })
  // Plugin panels sit between the totals and the pay button: the money is core,
  // and whatever a plugin adds about *this* sale belongs beside it.
  const panelsSlot = h('div', { class: 'px-3 pb-1' })
  const heldBadge = badge('0', { tone: 'warning', iconName: 'pause_circle' })
  /** How many lines are on the sale, beside the panel title. */
  const lineCountBadge = badge('0', { tone: 'neutral' })

  function renderCart(): void {
    const state = cart.state
    if (state.cart.lines.length === 0) {
      lineList.replaceChildren(
        h('div', { class: 'flex flex-col items-center justify-center px-4 py-10 text-center lg:h-full' },
          h('span', {
            class: 'grid h-12 w-12 place-items-center rounded-full bg-surface-muted text-content-subtle',
          }, icon('shopping_cart', 'text-2xl')),
          h('p', { class: 'mt-3 text-sm font-medium text-content', text: 'Scan or search to start a sale.' }),
          h('p', {
            class: 'mt-1 text-xs text-content-subtle',
            text: 'Enter adds the highlighted product · F2 opens payment',
          })
        )
      )
    } else {
      lineList.replaceChildren(...state.cart.lines.map((line) => cartLine(line.lineId)))
    }

    const totals = state.totals
    totalsBox.replaceChildren(
      totalRow('Subtotal', totals.subtotal),
      ...(totals.discount > 0
        ? [totalRow('Discount', (0 - totals.discount) as Minor, 'text-success')]
        : []),
      ...(totals.tax > 0 ? [totalRow('Tax', totals.tax)] : []),
      h('div', { class: 'flex items-baseline justify-between gap-2 pt-2 border-t border-border' },
        h('span', { class: 'text-sm font-medium text-content', text: 'Total' }),
        h('span', {
          class: 'min-w-0 truncate text-2xl font-semibold text-content tabular-nums tracking-tight',
          text: formatMoney(totals.total, { currency }),
        })
      )
    )

    // The strip of what a plugin can take off *this* cart. Drawn with the
    // totals because it changes them, and re-drawn on every cart change so an
    // adjustment the cart has outgrown is withdrawn rather than honoured.
    if (registry.saleAdjustments.items.length > 0) {
      mount(
        adjustmentsSlot,
        saleAdjustmentsHost(registry, adjustmentContext(), {
          applied: appliedAdjustments,
          onApply: applyAdjustment,
          onRemove: removeAdjustment,
        })
      )
    } else {
      mount(adjustmentsSlot, null)
    }

    // Completing, holding or clearing a sale empties the cart's customer id.
    // The chips are a view of that id, so they have to go with it — otherwise
    // the next customer starts their sale with the last one's name on it.
    if (state.cart.customerId === null && attachedCustomers.length > 0) {
      attachedCustomers = []
      renderCustomer()
    }

    const count = state.cart.lines.length
    lineCountBadge.textContent = t('common.itemCount', { count })
    lineCountBadge.classList.toggle('hidden', count === 0)

    // What the sale is still missing, in the order a cashier fixes it. The
    // button says which one rather than sitting there greyed out with no
    // explanation — "Pay" that cannot be pressed is a bug report waiting to
    // be filed.
    const missing = missingBeforePayment()
    payButton.disabled = missing !== null || state.busy
    setPayLabel(missing ?? 'Pay with invoice')
    payButton.title = missing ?? 'Take payment (F2)'
    quickPayButton.disabled = missing !== null || state.busy
    holdButton.disabled = state.cart.lines.length === 0 || state.busy
    clearButton.disabled = state.cart.lines.length === 0 || state.busy

    // Panels are re-drawn with the cart because they are about the sale in
    // front of the cashier: a loyalty panel showing the previous total would be
    // worse than no panel at all.
    mount(panelsSlot, pluginPanelsHost(registry, cartContext()))

    void refreshHeld()
  }

  /**
   * The cart as every plugin slot sees it (docs/11 §Slots).
   *
   * `total` is the cart total *including* any adjustment already applied, which
   * is what a plugin quoting a further discount has to reason about — and the
   * reason the strip is re-drawn on every cart change.
   */
  function cartContext(): PluginPanelContext {
    return {
      organizationId: organization?.organization_id ?? '',
      branchId: floor.branchId,
      currency,
      total: minorToNumber(cart.state.totals.total),
      customerId: cart.state.cart.customerId,
      // What is in the cart, for a plugin that decorates *this* sale — a
      // serial to attach to a line, a promotion that applies to what is being
      // bought (spec §51).
      lines: panelLines(cart.state.cart.lines, (variantId) => seen.get(variantId)),
    }
  }

  /** Who the sale is billed to: the first chip, or nobody. */
  function billedCustomer(): CustomerRow | null {
    return attachedCustomers[0] ?? null
  }

  /** Writes the list back to the cart, which is what the server prices. */
  function commitCustomers(): void {
    cart.setCustomer(billedCustomer()?.id ?? null)
    renderCustomer()
  }

  /** Everyone the dialog now has ticked. */
  function setCustomers(customers: CustomerRow[]): void {
    attachedCustomers = [...customers]
    commitCustomers()
  }

  /**
   * One person on the sale: their name, and the one control that takes them
   * off again.
   *
   * The cross is its own button rather than a click target on the chip, because
   * a chip that removes itself when tapped is how a cashier loses the customer
   * they just spent ten seconds searching for.
   */
  function customerChip(customer: CustomerRow, billed: boolean): HTMLElement {
    const remove = h('button', {
      type: 'button',
      class:
        'grid h-5 w-5 shrink-0 place-items-center rounded-full text-content-subtle ' +
        'hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'aria-label': `Remove ${customer.name}`,
      title: `Remove ${customer.name}`,
    }, icon('close', 'text-[15px]'))
    remove.addEventListener('click', () => {
      attachedCustomers = attachedCustomers.filter((row) => row.id !== customer.id)
      commitCustomers()
    })

    return h('div', {
      class: [
        // `max-w-full` + `truncate` on the name: a long name shortens, it does
        // not push the row sideways. The row wraps instead (spec §19).
        'inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1',
        billed ? 'border-primary/30 bg-primary/10' : 'border-border bg-surface-muted',
      ].join(' '),
      'data-customer-chip': customer.id,
    },
      h('span', {
        class: `min-w-0 truncate text-xs ${billed ? 'font-medium text-primary' : 'text-content'}`,
        text: customer.name,
        title: customer.phone ? `${customer.name} · ${customer.phone}` : customer.name,
      }),
      remove
    )
  }

  function renderCustomer(): void {
    if (!can('customers.view')) {
      mount(customerLine, null)
      return
    }

    const chips = attachedCustomers.map((customer, index) => customerChip(customer, index === 0))

    mount(
      customerLine,
      h('div', { class: 'flex items-center gap-2' },
        button('Add Customer', {
          // `md` (40px), not `sm` (32px): this spans the width of the cart
          // panel and is the only way to put a customer on the sale, so it is
          // a thumb target on a phone rather than a dense secondary control.
          size: 'md',
          variant: 'ghost',
          icon: 'person_add',
          ariaLabel: 'Add a customer to this sale',
          title: 'Search the customers this shop already has, or add a new one',
          class: 'min-w-0 flex-1 justify-start',
          onClick: () =>
            openCustomerDialog({ selected: attachedCustomers, currency, onChange: setCustomers }),
        }),
        h('span', {
          class: 'shrink-0 text-[11px] text-content-subtle',
          // "Anonymous" rather than "optional": the cashier is told what the
          // sale *will* be, not what they are permitted to skip. A till that
          // leaves the question open invites a pause at the counter.
          text: chips.length === 0 ? 'Anonymous' : chips.length === 1 ? 'billed to' : `${chips.length} people`,
        })
      ),
      // The chips sit *below* the button, on their own wrapping row, so the
      // fourth customer moves the list down rather than squeezing the three
      // before it into initials.
      chips.length > 0
        ? h('div', { class: 'mt-1.5 flex flex-wrap items-center gap-1.5' }, ...chips)
        : null
    )
  }

  function totalRow(label: string, amount: Minor, extraClass = ''): HTMLElement {
    return h('div', { class: 'flex items-baseline justify-between gap-2' },
      h('span', { class: 'min-w-0 truncate text-xs text-content-muted', text: label }),
      h('span', { class: `text-sm text-content tabular-nums ${extraClass}`.trim(), text: formatMoney(amount, { currency }) })
    )
  }

  /**
   * One line in the cart.
   *
   * ── Why this is two rows, not three columns ──────────────────────────────
   * It used to be `[name | stepper | total+delete]` in a single row, each
   * column sized by its content. At 360px the stepper and the total claimed
   * roughly 260px between them and the name was left with about 40 — so
   * "Only 0 in stock" wrapped one word per line, the line total was clipped by
   * the panel edge, and the list grew a horizontal scrollbar (an `overflow-y`
   * container computes `overflow-x: auto`, so any overflowing child shows one).
   *
   * Now the row that must never wrap — name and money — owns the full width,
   * and the controls sit underneath where they can be thumb-sized. Everything
   * that can overflow is `min-w-0` + `truncate`; nothing is wider than the
   * panel, so there is nothing left to scroll sideways.
   */
  function cartLine(lineId: string): HTMLElement {
    const state = cart.state
    const line = state.cart.lines.find((l) => l.lineId === lineId)
    if (!line) return h('div')
    const totals = state.totals.lines.find((t) => t.lineId === lineId)
    // The stepper counts 1, 2, 3 for every line; a weighed quantity is
    // typed (1.250) or scanned, and the +/− then move it by whole units.
    const step: Milli = milli(1000)
    const oversold = state.totals.oversold.includes(lineId)

    const qtyInput = input({
      type: 'text',
      inputmode: 'decimal',
      value: formatQty(line.quantity, { decimal: line.decimalQuantity }),
      // Sits inside the stepper group, so it drops the control's own border
      // and rounding rather than drawing a second box inside a box.
      class: 'h-9 w-14 min-w-0 rounded-none border-0 bg-transparent px-1 text-center text-sm tabular-nums focus:ring-0',
      onEnter: (value) => {
        const parsed = parseMilli(value, { decimal: line.decimalQuantity })
        if (parsed !== null && parsed > 0) cart.setQuantity(lineId, parsed)
        else renderCart()
      },
    })
    qtyInput.setAttribute('aria-label', `Quantity of ${line.name}`)

    const stepper = h('div',
      {
        class:
          'flex items-center rounded-md border border-border bg-surface shrink-0 ' +
          'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring',
      },
      iconButton('remove', 'Decrease', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => cart.increment(lineId, (0 - step) as Milli),
      }),
      qtyInput,
      iconButton('add', 'Increase', {
        size: 'sm',
        variant: 'ghost',
        onClick: () => cart.increment(lineId, step),
      })
    )

    return h(
      'div',
      {
        class: `group rounded-lg border px-2.5 py-2 transition-colors ${
          oversold ? 'border-danger bg-danger/5' : 'border-border bg-surface hover:border-ring/40'
        }`.trim(),
        dataset: { lineId },
      },
      // Row 1 — what it is, and what it costs. Never wraps, never clipped.
      h('div', { class: 'flex items-start gap-2' },
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'truncate text-sm font-medium leading-tight text-content', title: line.name, text: line.name }),
          line.variantName
            ? h('p', { class: 'truncate text-xs text-content-muted', text: line.variantName })
            : null
        ),
        h('p', {
          class: 'shrink-0 text-sm font-semibold tabular-nums text-content',
          text: formatMoney(totals?.total ?? (0 as Minor), { currency }),
        }),
        iconButton('close', 'Remove line', {
          size: 'sm',
          variant: 'ghost',
          class: 'shrink-0 -mr-1.5 -mt-1 text-content-subtle hover:text-danger',
          onClick: () => cart.remove(lineId),
        })
      ),
      // Row 2 — the controls, and the unit price they multiply.
      h('div', { class: 'mt-1.5 flex items-center justify-between gap-2' },
        h('p', {
          class: 'min-w-0 truncate text-xs tabular-nums text-content-subtle',
          text: `${formatMoney(line.unitPrice, { currency })} ×`,
        }),
        stepper
      ),
      // Row 3 — only when the shop cannot cover it. A full-width strip, so the
      // sentence reads as a sentence.
      oversold
        ? h('p', {
            class: 'mt-1.5 flex items-center gap-1 rounded bg-danger/10 px-1.5 py-1 text-[11px] font-medium text-danger',
            text: `Only ${formatQty(line.availableQty ?? milli(0), { decimal: line.decimalQuantity })} in stock`,
          })
        : null
    )
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  // Green, not brand: the one button on this screen that takes money is the
  // one button that must never be confused with the others.
  const payButton = button('Pay with invoice', {
    variant: 'success',
    size: 'xl',
    icon: 'payments',
    fullWidth: true,
    onClick: () => openPayment(),
  })
  // The label changes to name what the sale is still missing, so nothing may
  // find this button by its words.
  payButton.dataset.action = 'pay'

  /**
   * The queue button: the sale, without the paperwork.
   *
   * It banks exactly the same sale the invoiced button does — stock moves, it
   * lands in Sales history, the reports are right — and skips only what the
   * counter queue has no time for: the tender dialog and the receipt. The
   * tender it assumes is the obvious one, the whole total in cash.
   *
   * The invoice is deferred, not lost. Sales history can preview, print,
   * image or PDF any sale afterwards, which is when the customer usually
   * asks for it anyway.
   */
  const quickPayButton = button('Pay without invoice', {
    variant: 'outline',
    size: 'lg',
    icon: 'bolt',
    fullWidth: true,
    title: 'Record the sale and clear the till — full total in cash, no receipt',
    onClick: () => quickPay(),
  })
  quickPayButton.dataset.action = 'quick-pay'

  const holdButton = button('Hold', {
    variant: 'outline',
    size: 'lg',
    icon: 'pause',
    onClick: () => void holdCart(),
  })

  const clearButton = button('Clear', {
    variant: 'outline',
    size: 'lg',
    icon: 'delete_sweep',
    class: 'text-danger hover:border-danger/50 hover:bg-danger-soft hover:text-danger',
    onClick: () => void clearCart(),
  })

  // ── Sale adjustments (money off, from a plugin) ─────────────────────────

  /**
   * The one order discount the sale carries is the sum of what is applied.
   *
   * `complete_sale` has taken a `FLAT` order discount since migration 012 and
   * the cart domain has modelled it since the first commit; what was missing
   * was anything a shopkeeper could press. Several plugins can contribute — a
   * loyalty redemption, later a promotion — and the sale stores one number, so
   * the host sums them here and each plugin keeps its own share in its own
   * ledger.
   */
  function syncOrderDiscount(): void {
    const sum = appliedAdjustments.reduce((total, entry) => total + entry.quote.amountMinor, 0)
    if (sum > 0) cart.setOrderDiscount('FLAT', sum)
    else if (cart.state.cart.discountValue !== 0 || cart.state.cart.discountType !== null) {
      // A discount the till cannot explain is not kept: after a reload the
      // plugin's quote is gone, and honouring an amount nothing remembers
      // would take money off every sale the cashier rings up.
      cart.setOrderDiscount(null, 0)
    }
  }

  /**
   * What every adjustment is quoted against: the sale before the order-level
   * discount, applied or not.
   *
   * Not the cart total — that already has the discount in it, so a plugin
   * quoting `min(balance, total)` would watch its own offer shrink every time
   * the strip re-drew. And an emptied cart reads as ৳0 here, which is what
   * withdraws a redemption priced for a sale that no longer exists.
   */
  function adjustmentContext(): SaleAdjustmentContext {
    const context = cartContext()
    return {
      organizationId: organization?.organization_id ?? '',
      branchId: floor!.branchId,
      currency,
      customerId: context.customerId ?? null,
      totalMinor: cart.state.totals.beforeOrderDiscount,
      ...(context.lines ? { lines: context.lines } : {}),
    }
  }

  function applyAdjustment(
    adjustment: SaleAdjustmentDefinition,
    quote: SaleAdjustmentQuote
  ): void {
    void (async () => {
      appliedAdjustments = [
        ...appliedAdjustments.filter((entry) => entry.id !== adjustment.id),
        { id: adjustment.id, source: adjustment.source ?? 'plugin', quote },
      ]
      try {
        // Money moves *here*, and only if the plugin could record it. An
        // offline till that cannot debit the customer's points must not give
        // away the shop's money — the cashier is told and can try again.
        await adjustment.onApplied?.(quote, adjustmentContext())
      } catch (error) {
        appliedAdjustments = appliedAdjustments.filter((entry) => entry.id !== adjustment.id)
        syncOrderDiscount()
        toastError(
          error instanceof Error
            ? `${adjustment.label}: ${error.message}`
            : `${adjustment.label} could not be applied.`
        )
        return
      }
      syncOrderDiscount()
    })()
  }

  function removeAdjustment(
    adjustment: SaleAdjustmentDefinition,
    quote: SaleAdjustmentQuote,
    reason: SaleAdjustmentRelease
  ): void {
    const had = appliedAdjustments.some((entry) => entry.id === adjustment.id)
    appliedAdjustments = appliedAdjustments.filter((entry) => entry.id !== adjustment.id)
    syncOrderDiscount()
    if (!had) return
    void (async () => {
      try {
        await adjustment.onReleased?.(quote, reason)
      } catch (error) {
        // The discount is off the sale either way; what is lost is the
        // plugin's own bookkeeping, which it must reconcile itself.
        toastWarning(
          error instanceof Error
            ? `${adjustment.label}: ${error.message}`
            : `${adjustment.label} could not withdraw that cleanly.`
        )
      }
    })()
  }

  /** Everything off the sale — a held cart, a cleared one, or a finished sale. */
  function releaseAll(reason: SaleAdjustmentRelease): void {
    const entries = appliedAdjustments
    appliedAdjustments = []
    syncOrderDiscount()
    for (const entry of entries) {
      const adjustment = registry.saleAdjustments.items.find((item) => item.id === entry.id)
      if (!adjustment) continue
      void Promise.resolve(adjustment.onReleased?.(entry.quote, reason)).catch((error: unknown) => {
        console.error(`[plugin-host] "${entry.source}" could not release an adjustment`, error)
      })
    }
  }

  /** Told to every plugin whose money was in the sale that just completed. */
  function settleAdjustments(settlement: {
    saleId: string
    invoiceNo: string
    stored: boolean
  }): void {
    const entries = appliedAdjustments
    appliedAdjustments = []
    if (cart.state.cart.discountValue !== 0 || cart.state.cart.discountType !== null) {
      cart.setOrderDiscount(null, 0)
    }
    for (const entry of entries) {
      const adjustment = registry.saleAdjustments.items.find((item) => item.id === entry.id)
      if (!adjustment) continue
      void Promise.resolve(adjustment.onSettled?.(entry.quote, settlement)).catch(
        (error: unknown) => {
          toastWarning(`${entry.source} could not record the discount on ${settlement.invoiceNo}.`)
          console.error(`[plugin-host] "${entry.source}" could not settle an adjustment`, error)
        }
      )
    }
  }

  /**
   * Why this sale cannot be paid for yet, or `null` when it can.
   *
   * A product, and nothing else. The till used to insist on a customer too,
   * which is right for a shop that invoices and wrong for the counter queue
   * it was blocking: most sales over a counter are to nobody in particular,
   * and `sales.customer_id` has always been nullable. An anonymous sale is
   * now the default rather than a refusal, and the customer control stays
   * exactly where it is for the sales that need one.
   */
  function missingBeforePayment(): string | null {
    if (cart.state.cart.lines.length === 0) return 'Add a product'
    return null
  }

  /** Writes the button's words, never its icon (an icon font renders text as glyph soup). */
  function setPayLabel(text: string): void {
    const label = payButton.querySelector('[data-label]')
    if (label) label.textContent = text
  }

  function openPayment(): void {
    const state = cart.state
    const missing = missingBeforePayment()
    if (missing !== null) {
      // F2 lands here too, so the keyboard path gets the same answer as the
      // button.
      toastWarning('Add a product to the sale first.')
      searchField.focus()
      return
    }
    const problem = state.totals.oversold.length > 0
      ? 'Some lines exceed the stock on hand. Reduce them first.'
      : null
    if (problem) {
      toastWarning(problem)
      return
    }

    void (async () => {
      let methods: Awaited<ReturnType<typeof repos.catalog.listPaymentMethods>> = []
      try {
        methods = await repos.catalog.listPaymentMethods()
      } catch (error) {
        toastError(translateError(error).message)
        return
      }
      if (methods.length === 0) {
        toastError('This shop has no payment methods configured.')
        return
      }

      openPaymentDialog({
        total: state.totals.total,
        methods,
        currency,
        onSubmit: async (payments) => {
          // The dialog stays open on a throw, which is how a failed sale
          // keeps the tenders the cashier already entered.
          await bankSale(payments, { invoice: true })
        },
        // The khata path exists only when the sale has a name on it — the
        // server refuses an anonymous due (057), so the dialog never offers
        // one — and only while the due-ledger plugin is loaded: a shop that
        // does not sell on credit switched the whole idea off, and this
        // button is part of the idea. A string check, not an import — the
        // till does not know the plugin, only whether the shop keeps a
        // khata. Same bankSale: `complete_sale` books the underpayment as
        // PARTIALLY_PAID and the balance trigger writes it in the ledger.
        onDue:
          registry.loadedIds.includes('due-ledger') && cart.state.cart.customerId
            ? async (payments) => {
                await bankSale(payments, { invoice: true })
              }
            : undefined,
      })
    })()
  }

  /**
   * Take the money and write the sale down. The only route to `complete`.
   *
   * `invoice` decides what happens *after* the money is banked, and nothing
   * else: with an invoice the receipt opens for printing, without one the
   * till simply clears. Both write the identical sale — same stock movement,
   * same row in Sales history, same reports — because a shop that sells
   * without printing is still a shop that sold something.
   *
   * Throws on failure so the payment dialog can stay open with its tenders
   * intact; the quick path swallows it after the toast, having no dialog to
   * keep.
   */
  async function bankSale(payments: PaymentEntry[], options: { invoice: boolean }): Promise<void> {
    cart.setBusy(true)
    try {
      const result = await sales.complete({
        cart: cart.state.cart,
        payments,
        floor: floor!,
        currency,
        organizationId: organization?.organization_id ?? '',
        heldSaleId: cart.state.heldSaleId,
      })
      const heldId = cart.state.heldSaleId
      // Told before the cart goes: every plugin whose money was in this
      // sale learns which sale took it — and, offline, that the invoice
      // number is not final yet.
      settleAdjustments({
        saleId: result.sale_id,
        invoiceNo: result.invoice_no,
        stored: !result.queued,
      })
      cart.clear()
      if (result.queued) {
        // The money is real and the goods have gone; what is missing is
        // the invoice number. Saying "saved offline" is what stops the
        // cashier taking the sale a second time.
        toastWarning(
          `Saved on this device · ${formatMoney(minorFromString(result.total), { currency })}. ` +
            'It will sync when the connection returns.'
        )
      } else {
        toastSuccess(`Sale ${result.invoice_no} · ${formatMoney(minorFromString(result.total), { currency })}`)
      }

      // The sale is banked by this point: the money is taken, the stock
      // has moved and the cart is empty. Fetching it back to draw the
      // receipt is a *separate* job, and it used to be inside the same
      // try — so one bad column in that query reported a completed sale
      // as a failure, left the payment dialog open on an error, and
      // invited the cashier to take the same money twice.
      if (options.invoice) {
        try {
          const sale = await repos.sales.get(result.sale_id)
          if (sale) openReceipt(sale, currency, 'Mekholi', printableNotes(registry, seen.values()))
        } catch (error) {
          toastWarning(
            `Sale ${result.invoice_no} is saved, but the receipt could not be loaded: ` +
              `${translateError(error).message} Reprint it from Sales.`
          )
        }
      }

      if (heldId) void refreshHeld()
      searchField.focus()
    } catch (error) {
      toastError(translateError(error).message)
      throw error
    } finally {
      cart.setBusy(false)
    }
  }

  /**
   * The queue button: money in, sale written, no paperwork.
   *
   * One tap and the sale is banked exactly as an invoiced one — stock moves,
   * it appears in Sales history, the reports are right — but nothing is
   * printed and no dialog interrupts. It assumes the obvious tender: the
   * whole total, in cash, which is what a counter queue actually hands over.
   * Anything else (a split, a card, change from a larger note) is what the
   * invoiced button's dialog is for.
   *
   * The invoice is not lost by skipping it here. Every sale can be previewed,
   * printed, imaged or PDF'd afterwards from Sales history, which is where
   * the request usually arrives anyway.
   */
  function quickPay(): void {
    const state = cart.state
    if (state.busy) return
    if (state.cart.lines.length === 0) {
      toastWarning('Add a product to the sale first.')
      searchField.focus()
      return
    }
    if (state.totals.oversold.length > 0) {
      toastWarning('Some lines exceed the stock on hand. Reduce them first.')
      return
    }

    void (async () => {
      let methods: Awaited<ReturnType<typeof repos.catalog.listPaymentMethods>> = []
      try {
        methods = await repos.catalog.listPaymentMethods()
      } catch (error) {
        toastError(translateError(error).message)
        return
      }

      // Cash, or whatever this shop uses in its place. A quick sale with no
      // method to book it against would be a sale with no payment row, so it
      // refuses rather than inventing one.
      const cash = methods.find((method) => method.is_cash) ?? methods[0]
      if (!cash) {
        toastError('This shop has no payment methods configured.')
        return
      }

      try {
        await bankSale(
          [{ methodId: cash.id, methodKey: cash.key, methodName: cash.name, amount: state.totals.total }],
          { invoice: false }
        )
      } catch {
        // `bankSale` has already said what went wrong. There is no dialog
        // holding the cashier's tenders here, so the cart stays as it was
        // and the button can simply be pressed again.
      }
    })()
  }

  async function holdCart(): Promise<void> {
    cart.setBusy(true)
    try {
      // A parked sale is not this sale. The redemption goes back to the
      // customer and the cashier applies it again when the sale resumes —
      // otherwise a held cart would carry a discount no screen can undo.
      releaseAll('cleared')
      await sales.hold(cart.state.cart, floor!)
      cart.clear()
      toastSuccess('Sale held — resume it from the Held list.')
      searchField.focus()
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      cart.setBusy(false)
    }
  }

  async function clearCart(): Promise<void> {
    const ok = await confirm('Clear this cart?', {
      message: 'The items will be discarded. Hold the sale instead if you may return to it.',
      confirmLabel: 'Clear',
      tone: 'danger',
      iconName: 'delete_sweep',
    })
    if (ok) {
      releaseAll('cleared')
      cart.clear()
      searchField.focus()
    }
  }

  async function refreshHeld(): Promise<void> {
    try {
      const held = await repos.sales.held(floor!.branchId)
      heldBadge.querySelector('span:last-child')!.textContent = String(held.length)
      heldBadge.classList.toggle('hidden', held.length === 0)
      heldCount.textContent = String(held.length)
      // Nothing held, nothing shown: an empty drawer is one more thing to read
      // on a screen that is mostly read at a glance.
      heldSection.classList.toggle('hidden', held.length === 0)
      if (held.length === 0) {
        heldList.classList.add('hidden')
        heldToggle.setAttribute('aria-expanded', 'false')
        heldChevron.textContent = 'expand_more'
      }
      heldList.replaceChildren(...held.map((sale) => heldRow(sale)))
    } catch {
      // A failed badge refresh is not worth interrupting a sale for.
    }
  }

  const heldList = h('div', { class: 'space-y-1 px-3 pb-3 max-h-48 overflow-y-auto' })

  /**
   * Held sales are a drawer, not a permanent block.
   *
   * They used to sit open at the bottom of the panel under a bare "Held sales"
   * label, stealing height from the cart and reading as a stray fragment when
   * there was nothing to show. Now the section hides itself entirely when the
   * count is zero, and opens on demand.
   */
  const heldToggle = h('button', {
    type: 'button',
    class:
      'flex w-full items-center gap-2 border-t border-border px-3 py-2 text-xs font-medium ' +
      'text-content-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 ' +
      'focus-visible:ring-ring',
    'aria-expanded': 'false',
  }) as HTMLButtonElement
  const heldChevron = icon('expand_more', 'text-base transition-transform')
  const heldCount = h('span', { class: 'ml-auto tabular-nums', text: '0' })
  heldToggle.append(icon('pause_circle', 'text-base'), h('span', { text: 'Held sales' }), heldCount, heldChevron)

  const heldSection = h('div', { class: 'hidden' }, heldToggle, heldList)
  heldList.classList.add('hidden')

  heldToggle.addEventListener('click', () => {
    const open = heldList.classList.toggle('hidden') === false
    heldToggle.setAttribute('aria-expanded', String(open))
    heldChevron.textContent = open ? 'expand_less' : 'expand_more'
  })

  function heldRow(sale: SaleRow): HTMLElement {
    const heldFor = Math.max(0, Math.round((Date.now() - new Date(sale.created_at).getTime()) / 60000))
    return h('div', { class: 'flex items-center justify-between gap-2 rounded-md border border-border p-2' },
      h('div', { class: 'min-w-0' },
        h('p', { class: 'text-xs font-medium text-content truncate', text: sale.customer?.name ?? 'Walk-in' }),
        h('p', { class: 'text-[11px] text-content-subtle', text: `${sale.invoice_no} · ${heldFor}m ago` })
      ),
      button('Resume', {
        size: 'sm',
        variant: 'outline',
        onClick: () => void resumeHeld(sale.id),
      })
    )
  }

  async function resumeHeld(saleId: string): Promise<void> {
    if (cart.state.cart.lines.length > 0) {
      const ok = await confirm('Replace the current cart?', {
        message: 'Resuming a held sale discards the cart on screen.',
        confirmLabel: 'Resume',
      })
      if (!ok) return
    }
    cart.setBusy(true)
    try {
      const resumed = await sales.resume(saleId, floor!.warehouseId)
      cart.replace(resumed.cart, saleId)
      // The held row carries the customer's id; the name is a lookup, and a
      // failure to fetch it must not lose the sale — the id is what the server
      // stores and what the receipt is joined from.
      const resumedCustomer = resumed.customerId
        ? await repos.customers.get(resumed.customerId).catch(() => null)
        : null
      attachedCustomers = resumedCustomer ? [resumedCustomer] : []
      renderCustomer()
      // A held sale was parked without its adjustments (see `holdCart`), so
      // anything on it now is a discount this till cannot explain.
      releaseAll('cleared')
      syncOrderDiscount()
      toastSuccess('Held sale resumed.')
      searchField.focus()
    } catch (error) {
      toastError(translateError(error).message)
    } finally {
      cart.setBusy(false)
    }
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'F2') {
      event.preventDefault()
      openPayment()
    } else if (event.key === 'F4') {
      event.preventDefault()
      void holdCart()
    } else if (event.key === 'F8') {
      event.preventDefault()
      void clearCart()
    } else if (event.key === '/' && document.activeElement !== searchField) {
      event.preventDefault()
      searchField.focus()
    }
  }

  const unsubscribeCart = cart.store.subscribe(() => {
    renderCart()
    // The ticks are a view of the cart, so they are redrawn by the cart —
    // including when a line is removed from the panel on the right.
    renderResults()
  })

  // ── Layout ──────────────────────────────────────────────────────────────

  const busyIndicator = h('div', { class: 'hidden items-center gap-2 px-3 py-1 text-xs text-content-muted' })

  root.append(
    h('section', { class: 'flex min-w-0 flex-col lg:min-h-0 lg:flex-1 lg:overflow-hidden' },
      // The search field is the till's front door and stays put while the grid
      // scrolls under it.
      h('div', { class: 'shrink-0 border-b border-border bg-surface px-3 pt-3 pb-2' }, searchField),
      statusLine,
      h('div', { class: 'lg:flex-1 lg:min-h-0 lg:overflow-y-auto' }, grid),
      // The keyboard contract, stated where a new cashier will see it. Hidden
      // on touch-sized screens, where there are no F-keys to press.
      h('p', {
        class: 'hidden border-t border-border px-3 py-1.5 text-[11px] text-content-subtle sm:block',
        text: 'Enter add · ↑↓ choose · F2 pay · F4 hold · F8 clear',
      })
    ),
    // The cart is a fixed rail beside the catalogue on a desktop, and simply
    // the next thing down the page on a phone — a counter is as often a phone
    // in portrait as it is a widescreen till, and a 360px rail squeezed into a
    // 390px viewport is neither.
    h('aside', {
      class:
        'flex w-full flex-col border-t border-border bg-surface ' +
        'lg:h-full lg:min-h-0 lg:w-[380px] lg:shrink-0 lg:overflow-hidden ' +
        'lg:border-l lg:border-t-0 xl:w-[420px]',
    },
      h('div', { class: 'flex items-center gap-2 border-b border-border px-3 py-2' },
        h('p', { class: 'text-sm font-semibold text-content', text: 'Current sale' }),
        lineCountBadge,
        h('div', { class: 'ml-auto' }, heldBadge)
      ),
      busyIndicator,
      customerLine,
      lineList,
      // Money off sits directly above the totals it changes, and above the
      // plugin panels that describe the sale.
      adjustmentsSlot,
      totalsBox,
      panelsSlot,
      h('div', { class: 'border-t border-border p-3 space-y-2' },
        payButton,
        quickPayButton,
        h('div', { class: 'grid grid-cols-2 gap-2' }, holdButton, clearButton)
      ),
      heldSection
    )
  )

  // Initial load. The grid is populated before the first paint of results so
  // the cashier sees something immediately rather than an empty pane.
  renderCustomer()
  void runSearch('')
  // A discount restored from a draft has no plugin quote behind it any more —
  // the redemption died with the tab. Dropping it here is what stops an
  // unexplained amount coming off every sale until someone notices.
  syncOrderDiscount()
  renderCart()
  busyIndicator.append(spinner('h-3 w-3'), h('span', { text: 'Working…' }))
  cart.store.select(
    (state) => state.busy,
    (busy) => busyIndicator.classList.toggle('hidden', !busy)
  )

  document.addEventListener('keydown', onKeyDown)

  /**
   * Scans from anywhere on the screen, not only from the search box.
   *
   * A wedge scanner types into whatever has focus, so a barcode fired while
   * the cashier's caret sat in the quantity field used to end up *in* the
   * quantity field. This listener recognises the burst by its speed (see
   * `shared/devices/scanner.ts`) and gives it to the till instead.
   *
   * When focus is already in the search box that box handles it, and handling
   * it twice would add the product twice.
   */
  const scannerConfig = loadDeviceSettings().scanner

  // Serial is the one scanner mode that can be configured and then not work:
  // Web Serial exists only in Chrome and Edge on a desktop, and a shop that
  // chose it on a PC and then opened the till on an iPad would scan into
  // nothing with no explanation. Say so once, on arrival, with the page that
  // fixes it attached — a scan that silently does nothing is the hardest
  // fault in the shop to diagnose.
  if (scannerConfig.mode === 'serial' && !capabilities().serial.supported) {
    promptDeviceSetup('scanner', 'This scanner is set to serial mode, which this browser does not support.')
  }

  const stopScanner = listenForScans({
    ...scannerConfig,
    onScan: (event) => {
      if (document.activeElement === searchField) return
      if (scannerConfig.beep) beep(true)
      searchField.value = event.code
      void runSearch(event.code)
    },
  })

  // Tear down the document listener when the router replaces this view, or the
  // F-keys keep firing against a screen that is no longer there.
  const observer = new MutationObserver(() => {
    if (!root.isConnected) {
      observer.disconnect()
      document.removeEventListener('keydown', onKeyDown)
      stopScanner()
      unsubscribeCart()
      if (searchTimer) clearTimeout(searchTimer)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  return root
}

/** PostgREST returns numeric as text; convert for display. */
function minorFromString(value: string): Minor {
  return Math.round(Number(value) * 100) as Minor
}
