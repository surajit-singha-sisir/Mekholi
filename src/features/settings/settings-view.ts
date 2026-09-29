/**
 * Shop settings (Phase 4).
 *
 * Business profile, receipt/device preferences, taxes and payment methods are
 * deliberately kept together. The tables already existed; this screen is the
 * missing owner workflow that makes them changeable without SQL.
 */

import { h, mount } from '../../components/ui/h'
import { button, spinner } from '../../components/ui/button'
import { badge, card, emptyState } from '../../components/ui/card'
import { checkbox, field, input, select, textarea } from '../../components/ui/input'
import { imagePicker } from '../../components/ui/image-upload'
import { modal } from '../../components/feedback/modal'
import { toastError, toastSuccess } from '../../components/feedback/toast'
import { getRepositories } from '../../app/data'
import { can } from '../../app/state/session'
import {
  adoptImageUploadKey,
  imageKeySource,
  imageUploadKey,
  imageUploadsEnabled,
  probeImageUploadKey,
  setImageUploadKey,
  uploadImage,
  validateImageFile,
  IMGBB_SETTINGS_KEY,
} from '../../app/images'
import { translateError } from '../../app/platform/errors'
import { applyShopLocale, locale as activeLocale, setLocale, t, LOCALE_NAMES } from '../../shared/i18n'
import { currencyOptions } from '../../shared/domain/currencies'
import { deviceTimeZone, timeZoneOptions } from '../../shared/domain/timezones'
import { setTheme, theme as activeTheme, THEMES, type Theme } from '../../shared/theme'
import type { PaymentMethod, Tax } from '../../shared/types/records'

interface SettingsBag {
  receiptFooter?: string
  receiptShowLogo?: boolean
  autoPrintReceipt?: boolean
  deviceName?: string
  /** The shop's own ImgBB upload key (docs/15). Public by ImgBB's design. */
  imgbbApiKey?: string
  [key: string]: unknown
}

export function settingsView(): HTMLElement {
  const repos = getRepositories()
  let settings: Awaited<ReturnType<typeof repos.organization.getSettings>> | null = null
  let taxes: Tax[] = []
  let paymentMethods: PaymentMethod[] = []
  let loading = true
  /** A supporting card failed to load; the page still renders without it. */
  let sideLoadError: string | null = null

  const root = h('div', { class: 'p-3 sm:p-6' })
  const content = h('div', { class: 'w-full space-y-4' })

  function notice(message: string): void {
    mount(content, emptyState(t('settings.loadFailed'), { description: message, iconName: 'error' }))
  }

  /**
   * Loading order matters here, and it used to be wrong: `render()` ran inside
   * the `try` while `loading` was still true, and `loading = false` only
   * followed in `finally` — after the only redraw. The screen drew its spinner
   * and then had nothing left to draw it again, so Settings sat spinning
   * forever. The flag is cleared *before* the render now.
   */
  async function load(): Promise<void> {
    try {
      // The shop profile is the screen. Without it there is nothing to show.
      settings = await repos.organization.getSettings()
      // Before anything renders: the image pickers below ask
      // `imageUploadsEnabled()` while they are being built, and a shop whose
      // key lives only in the database would otherwise draw them disabled
      // on the very screen that configures them.
      adoptImageUploadKey(settings.settings)
      // The shop's saved language seeds a device that has not chosen one. It
      // must not *override* a choice made here: this load runs again on every
      // redraw, and a redraw is exactly what switching the language causes.
      applyShopLocale(settings.locale)

      // Taxes and payment methods are supporting cards. A role that may edit
      // the shop name but not read tax rules should still get the page, so a
      // failure here costs one card — not the whole screen.
      const [taxResult, methodResult] = await Promise.allSettled([
        repos.catalog.listAllTaxes(),
        repos.catalog.listAllPaymentMethods(),
      ])
      taxes = taxResult.status === 'fulfilled' ? taxResult.value : []
      paymentMethods = methodResult.status === 'fulfilled' ? methodResult.value : []
      const partial = [taxResult, methodResult].find((result) => result.status === 'rejected')
      sideLoadError = partial ? translateError(partial.reason).message : null

      loading = false
      render()
    } catch (error) {
      loading = false
      notice(translateError(error).message)
    }
  }

  function render(): void {
    if (loading || !settings) {
      // Tagged so a test can tell this spinner from the one inside a control.
      mount(content, h('div', { class: 'flex justify-center p-12', dataset: { state: 'loading' } }, spinner()))
      return
    }
    const bag = settings.settings as SettingsBag
    const name = input({ value: settings.name })
    // Currency and time zone are chosen, not typed. Both are codes the
    // database validates and neither is memorable: a free-text box turned
    // every save into a spelling test.
    const currency = select({
      value: settings.currency,
      options: currencyOptions(settings.currency),
    })
    const timezone = select({
      value: settings.timezone || deviceTimeZone(),
      options: timeZoneOptions(settings.timezone),
    })
    // The select reflects what the app is *speaking* right now, not only what
    // the database last stored: a language chosen on this device is applied
    // immediately, and the save then makes it the shop's default.
    const localeSelect = select({
      // The language in force on this device, not the one the row remembers:
      // the select must show what the user is looking at.
      value: activeLocale(),
      options: [
        { value: 'en', label: LOCALE_NAMES.en },
        { value: 'bn', label: LOCALE_NAMES.bn },
      ],
    })
    // Applied on change, before any save. Waiting for a round trip to see your
    // own language is what made this control feel broken.
    localeSelect.addEventListener('change', () => {
      setLocale(localeSelect.value)
    })
    const footer = textarea({ value: typeof bag.receiptFooter === 'string' ? bag.receiptFooter : '', rows: 2, placeholder: t('settings.receiptFooterPlaceholder') })
    const deviceName = input({ value: typeof bag.deviceName === 'string' ? bag.deviceName : '', placeholder: t('settings.deviceNamePlaceholder') })
    const showLogo = checkbox({ label: t('settings.showLogo'), checked: bag.receiptShowLogo !== false })
    const autoPrint = checkbox({ label: t('settings.autoPrint'), checked: bag.autoPrintReceipt === true })
    // The logo is uploaded to ImgBB and stored as a URL, the same way product
    // photos are. Receipts and the sidebar read `logoUrl`, so one upload here
    // changes both without a second place to keep the file.
    const shopName = settings.name
    const logo = imagePicker({
      value: settings.logoUrl,
      label: `${shopName} logo`,
      // Square, and cropped to square: a logo box that changes shape with
      // whatever file was picked makes the whole card jump on upload.
      previewClass: 'h-20 w-20',
      validate: (file) => validateImageFile(file),
      ...(imageUploadsEnabled()
        ? {
            upload: async (file, onProgress) => {
              const uploaded = await uploadImage(file, { name: `${shopName} logo`, onProgress })
              return { url: uploaded.url, thumbUrl: uploaded.thumbUrl }
            },
          }
        : { disabledHint: t('settings.shopLogoDisabled') }),
    })
    // Named for the tests and for anyone inspecting the page: with five
    // controls on one card, "the first select" is not an identity.
    name.dataset.field = 'name'
    currency.dataset.field = 'currency'
    timezone.dataset.field = 'timezone'
    localeSelect.dataset.field = 'locale'

    const saveButton = button(t('settings.save'), { variant: 'primary', icon: 'save', disabled: !can('settings.business') })

    saveButton.addEventListener('click', () => {
      void (async () => {
        saveButton.disabled = true
        try {
          const logoUrl = await logo.commit()
          settings = await repos.organization.updateSettings({
            name: name.value.trim(),
            logoUrl,
            currency: currency.value.trim().toUpperCase(),
            timezone: timezone.value.trim(),
            locale: localeSelect.value,
            settings: {
              ...bag,
              receiptFooter: footer.value.trim(),
              deviceName: deviceName.value.trim(),
              receiptShowLogo: Boolean(showLogo.querySelector('input')?.checked),
              autoPrintReceipt: Boolean(autoPrint.querySelector('input')?.checked),
            },
          })
          setLocale(localeSelect.value)
          toastSuccess(t('settings.saved'))
          render()
        } catch (error) {
          toastError(translateError(error).message)
          saveButton.disabled = false
        }
      })()
    })

    const businessCard = card(
      t('settings.shopDetails'),
      h('div', { class: 'grid gap-4 sm:grid-cols-2' },
        field(t('settings.shopName'), name, { required: true }),
        field(t('settings.currency'), currency, { required: true, hint: t('settings.currencyHint') }),
        field(t('settings.timezone'), timezone, { required: true, hint: t('settings.timezoneHint') }),
        field(t('settings.language'), localeSelect, { required: true, hint: t('settings.languageHint') })
      ),
      // No hint when uploads work: where the bytes are stored is Mekholi's
      // business, not the shopkeeper's, and the sentence was longer than the
      // control it explained. The disabled case still says why nothing
      // happens when you click.
      field(t('settings.shopLogo'), logo.root,
        imageUploadsEnabled() ? {} : { hint: t('settings.shopLogoDisabled') }
      ),
      h('div', { class: 'mt-4 flex justify-end' }, saveButton)
    )

    // ── Image uploads ────────────────────────────────────────────────────
    // The key that makes every picture in the app possible, in the one place
    // an owner can reach. It was a build-time variable, which meant product
    // photos were switched off in every deployment nobody had rebuilt — and
    // the disabled hint told a shopkeeper to edit an environment file. This
    // card is the fix: paste a key, test it, save it, and every device in
    // the shop has photos on the next load (docs/15).
    const imgbbCard = buildImageUploadCard(bag)

    // ── Appearance ───────────────────────────────────────────────────────
    // A device preference, not a shop one: the counter tablet under a shop
    // light and the owner's phone in bed want different answers, and they
    // share a row in the database. Nothing here is saved to the server.
    const themeSelect = select({
      value: activeTheme(),
      options: THEMES.map((name) => ({ value: name, label: t(`theme.${name}`) })),
      onChange: (value) => setTheme(value as Theme),
    })
    themeSelect.dataset.field = 'theme'
    const appearanceCard = card(
      t('settings.appearance'),
      h('div', { class: 'grid gap-4 sm:grid-cols-2' },
        field(t('settings.theme'), themeSelect, { hint: t('settings.themeHint') })
      )
    )

    const receiptCard = card(
      t('settings.receiptDevice'),
      h('div', { class: 'grid gap-4 sm:grid-cols-2' },
        field(t('settings.receiptFooter'), footer, { hint: t('settings.receiptFooterHint') }),
        field(t('settings.deviceName'), deviceName, { hint: t('settings.deviceNameHint') })
      ),
      h('div', { class: 'mt-4 flex flex-col gap-3' }, showLogo, autoPrint)
    )

    const taxesCard = card(
      t('settings.taxes'),
      h('div', { class: 'space-y-2' },
        ...taxes.map((tax) => taxRow(tax)),
        taxes.length === 0 ? emptyState(t('settings.noTaxes'), { description: t('settings.noTaxesHint'), iconName: 'percent' }) : null
      ),
      can('settings.create') ? h('div', { class: 'mt-4 flex justify-end' }, button(t('settings.addTax'), { variant: 'outline', icon: 'add', onClick: () => openTaxForm(null) })) : null
    )

    const paymentCard = card(
      t('settings.paymentMethods'),
      h('div', { class: 'space-y-2' },
        ...paymentMethods.map((method) => paymentRow(method)),
        paymentMethods.length === 0 ? emptyState(t('settings.noPaymentMethods'), { description: t('settings.noPaymentMethodsHint'), iconName: 'payments' }) : null
      )
    )

    mount(content,
      h('div', { class: 'flex flex-wrap items-end justify-between gap-3' },
        h('div', {},
          h('h1', { class: 'text-lg font-semibold text-content', text: t('settings.title') }),
          h('p', { class: 'mt-1 text-sm text-content-muted', text: t('settings.subtitle') })
        ),
        settings.slug ? badge(settings.slug, { tone: 'neutral' }) : null
      ),
      sideLoadError
        ? h('p', {
            class: 'rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-content-muted',
            role: 'status',
            text: t('settings.partialFailure', { message: sideLoadError }),
          })
        : null,
      businessCard,
      imgbbCard,
      appearanceCard,
      receiptCard,
      taxesCard,
      paymentCard
    )
  }

  /**
   * The ImgBB card.
   *
   * Three things an owner needs and had none of: to see whether uploads are
   * on, to test a key before trusting it, and to save it without a deploy.
   *
   * It saves on its own rather than through the Shop details button, and it
   * writes the new key back into the captured `bag` afterwards — the other
   * card spreads `...bag` when it saves, so skipping that would let a later
   * "Save shop details" quietly wipe the key that had just been stored.
   */
  function buildImageUploadCard(bag: SettingsBag): HTMLElement {
    const editable = can('settings.business')
    const keyInput = input({
      value: imageUploadKey(),
      placeholder: 'e.g. 2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
      autocomplete: 'off',
      disabled: !editable,
    })
    keyInput.dataset.field = 'imgbbApiKey'
    keyInput.spellcheck = false

    const statusSlot = h('p', { class: 'text-xs', dataset: { field: 'imgbbStatus' } })
    const resultSlot = h('p', { class: 'mt-2 text-xs hidden', role: 'status' })

    /**
     * Reflects the key that is *in force*, not the text in the box. A typed
     * but unsaved key has changed nothing yet, and saying otherwise is how
     * an owner ends up believing uploads work when they do not.
     */
    function drawStatus(): void {
      const source = imageKeySource()
      const label =
        source === 'shop'
          ? t('settings.imgbbOnShop')
          : source === 'build'
            ? t('settings.imgbbOnBuild')
            : t('settings.imgbbOff')
      statusSlot.textContent = label
      statusSlot.className =
        source === 'none' ? 'text-xs text-content-muted' : 'text-xs text-success'
    }

    function showResult(ok: boolean, message: string): void {
      resultSlot.textContent = message
      resultSlot.className = `mt-2 text-xs ${ok ? 'text-success' : 'text-danger'}`
      resultSlot.classList.remove('hidden')
    }

    const testButton = button(t('settings.imgbbTest'), {
      variant: 'outline',
      icon: 'science',
      disabled: !editable,
    })
    const saveKeyButton = button(t('settings.save'), {
      variant: 'primary',
      icon: 'save',
      disabled: !editable,
    })

    testButton.addEventListener('click', () => {
      void (async () => {
        const candidate = keyInput.value.trim()
        testButton.disabled = true
        resultSlot.classList.add('hidden')
        try {
          const probe = await probeImageUploadKey(candidate)
          showResult(probe.ok, probe.message)
        } finally {
          testButton.disabled = !editable
        }
      })()
    })

    saveKeyButton.addEventListener('click', () => {
      void (async () => {
        const next = keyInput.value.trim()
        saveKeyButton.disabled = true
        try {
          settings = await repos.organization.updateSettings({
            settings: { ...bag, [IMGBB_SETTINGS_KEY]: next },
          })
          // The captured bag is what Shop details will spread on its next
          // save. Mutating it keeps the two cards from overwriting one
          // another without forcing a full redraw that would throw away
          // whatever the owner has half-typed elsewhere on the page.
          bag[IMGBB_SETTINGS_KEY] = next
          setImageUploadKey(next)
          drawStatus()
          showResult(true, t('settings.imgbbSaved'))
          toastSuccess(t('settings.saved'))
        } catch (error) {
          const translated = translateError(error)
          showResult(false, translated.message)
          toastError(translated.message)
        } finally {
          saveKeyButton.disabled = !editable
        }
      })()
    })

    drawStatus()

    return card(
      t('settings.imageUploads'),
      h('p', { class: 'text-sm text-content-muted', text: t('settings.imgbbIntro') }),
      h('div', { class: 'mt-3' },
        field(t('settings.imgbbKey'), keyInput, { hint: t('settings.imgbbKeyHint') })
      ),
      h('div', { class: 'mt-1' }, statusSlot),
      resultSlot,
      h('div', { class: 'mt-4 flex flex-wrap justify-end gap-2' }, testButton, saveKeyButton)
    )
  }

  function taxRow(tax: Tax): HTMLElement {
    const active = badge(tax.is_active ? t('common.active') : t('common.off'), { tone: tax.is_active ? 'success' : 'neutral' })
    return h('div', { class: 'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3' },
      h('div', {},
        h('p', { class: 'font-medium text-content', text: tax.name }),
        h('p', { class: 'text-sm text-content-muted', text: `${tax.rate}% · ${tax.is_inclusive ? t('settings.taxIncluded') : t('settings.taxAdded_checkout')}` })
      ),
      h('div', { class: 'flex items-center gap-2' }, active, can('settings.edit') ? button(t('common.edit'), { variant: 'ghost', onClick: () => openTaxForm(tax) }) : null)
    )
  }

  function paymentRow(method: PaymentMethod): HTMLElement {
    const toggle = checkbox({ label: method.is_active ? t('common.active') : t('common.off'), checked: method.is_active })
    const control = toggle.querySelector('input') as HTMLInputElement | null
    control?.addEventListener('change', () => {
      void repos.catalog.updatePaymentMethod(method.id, { is_active: control.checked }).then((updated) => {
        paymentMethods = paymentMethods.map((item) => item.id === updated.id ? updated : item)
        render()
      }).catch((error) => {
        control.checked = method.is_active
        toastError(translateError(error).message)
      })
    })
    return h('div', { class: 'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3' },
      h('div', {},
        h('p', { class: 'font-medium text-content', text: method.name }),
        h('p', { class: 'text-sm text-content-muted', text: `${method.type}${method.is_cash ? ` · ${t('settings.cashDrawer')}` : ''}` })
      ),
      can('settings.edit') ? toggle : badge(t('common.readOnly'), { tone: 'neutral' })
    )
  }

  function openTaxForm(existing: Tax | null): void {
    const name = input({ value: existing?.name ?? '', autofocus: true, placeholder: 'VAT' })
    const rate = input({ type: 'text', inputmode: 'decimal', value: existing?.rate ?? '0', placeholder: '0' })
    const inclusive = checkbox({ label: t('settings.taxInclusive'), checked: existing?.is_inclusive === true })
    const active = checkbox({ label: t('settings.taxActive'), checked: existing?.is_active !== false })
    const error = h('p', { class: 'hidden text-sm text-danger', role: 'alert' })
    const save = button(existing ? t('settings.saveTax') : t('settings.addTax'), { variant: 'primary', fullWidth: true, size: 'lg' })
    const dialog = modal({ title: existing ? t('settings.editTax') : t('settings.addTax'), iconName: 'percent', size: 'sm', footer: [h('div', { class: 'w-full' }, save)] })
    dialog.body.replaceChildren(h('div', { class: 'space-y-4' }, field(t('settings.taxName'), name, { required: true }), field(t('settings.taxRate'), rate, { required: true }), inclusive, active, error))
    save.addEventListener('click', () => {
      void (async () => {
        const value = Number(rate.value)
        if (!name.value.trim() || !Number.isFinite(value) || value < 0 || value > 100) {
          error.textContent = t('settings.taxInvalid')
          error.classList.remove('hidden')
          return
        }
        save.disabled = true
        try {
          const isInclusive = Boolean(inclusive.querySelector('input')?.checked)
          const isActive = Boolean(active.querySelector('input')?.checked)
          const updated = existing
            ? await repos.catalog.updateTax(existing.id, { name: name.value.trim(), rate: value, is_inclusive: isInclusive, is_active: isActive })
            : await repos.catalog.createTax(name.value.trim(), value, isInclusive)
          taxes = existing ? taxes.map((tax) => tax.id === updated.id ? updated : tax) : [...taxes, updated]
          dialog.close()
          render()
          toastSuccess(existing ? t('settings.taxUpdated') : t('settings.taxAdded'))
        } catch (err) {
          error.textContent = translateError(err).message
          error.classList.remove('hidden')
          save.disabled = false
        }
      })()
    })
  }

  mount(root, content)
  // Draw the loading state immediately, so the first frame is a spinner rather
  // than an empty page while the profile is fetched.
  render()
  void load()
  return root
}

export default settingsView
