/**
 * Onboarding (spec §40): the account exists, the shop does not.
 *
 * Every path that can land a user here — a signup whose provisioning step
 * failed, an OAuth sign-in for a brand-new Google account, an invite created
 * before its shop — gets the same recovery: name the shop, pick what it
 * sells, and `provision_organization` builds branch, stock location,
 * register, roles, units and payment methods in one server-side step.
 *
 * This screen used to be a dead end ("sign out and start again"), which
 * meant an account with no organization could never get one without
 * database surgery.
 *
 * Beyond the two required fields it now also captures the preferences a
 * shopkeeper would otherwise have to hunt for in Settings straight after:
 * language, currency, time zone, appearance and a logo. Provisioning still
 * creates the shop; these are written in a best-effort follow-up patch, so a
 * hiccup saving a preference never blocks the shop from existing.
 */

import { h } from '../../components/ui/h'
import { button } from '../../components/ui/button'
import { input, select, field } from '../../components/ui/input'
import { imagePicker } from '../../components/ui/image-upload'
import { provisionShop } from '../../app/platform/auth'
import { bindDrafts, clearDraft } from '../../app/state/drafts'
import {
  imageUploadsEnabled,
  uploadImage,
  validateImageFile,
} from '../../app/images'
import { locale as activeLocale, setLocale, t, LOCALE_NAMES } from '../../shared/i18n'
import { currencyOptions } from '../../shared/domain/currencies'
import { deviceTimeZone, timeZoneOptions } from '../../shared/domain/timezones'
import { setTheme, theme as activeTheme, THEMES, type Theme } from '../../shared/theme'
import taxonomy from '../../../data/shop_categories.json'

interface ShopType {
  id: string
  name: string
  name_bn: string
  parentId: string
}

interface ShopGroup {
  id: string
  name: string
  name_bn: string
  parentId: null
  children: ShopType[]
}

const GROUPS = (taxonomy as { categories: ShopGroup[] }).categories

/** The default currency for a new shop; Settings can change it later. */
const DEFAULT_CURRENCY = 'BDT'

export interface OnboardingViewOptions {
  /** Called after the shop exists and the session payload has refreshed. */
  onDone: () => void
}

export function onboardingView(options: OnboardingViewOptions): HTMLElement {
  const shopName = input({ id: 'onboard-shop', placeholder: t('onboarding.shopNamePlaceholder'), autofocus: true })
  const shopType = select({
    id: 'onboard-type',
    options: GROUPS.flatMap((group) =>
      group.children.map((type) => ({ value: type.id, label: `${type.name_bn} · ${type.name}` }))
    ),
    placeholder: t('onboarding.shopTypePlaceholder'),
  })

  // Language applies to this device immediately on change; the choice is also
  // saved as the shop's default so every device starts in the same language.
  // Changing it re-renders the whole screen (main.ts listens for the change),
  // so this view is rebuilt in the new language with the typed name restored
  // from its draft.
  const localeSelect = select({
    value: activeLocale(),
    options: [
      { value: 'en', label: LOCALE_NAMES.en },
      { value: 'bn', label: LOCALE_NAMES.bn },
    ],
    onChange: (value) => setLocale(value),
  })

  // Currency and time zone are chosen, not typed — the database validates the
  // codes and neither is memorable. The time zone defaults to the device's, so
  // most shopkeepers never touch it.
  const currency = select({
    value: DEFAULT_CURRENCY,
    options: currencyOptions(DEFAULT_CURRENCY),
  })
  const deviceZone = deviceTimeZone()
  const timezone = select({
    value: deviceZone,
    options: timeZoneOptions(deviceZone),
  })

  // Theme is a device preference, never stored on the server: the counter
  // tablet and the owner's phone want different answers. Applied on change.
  const themeSelect = select({
    value: activeTheme(),
    options: THEMES.map((name) => ({ value: name, label: t(`theme.${name}`) })),
    onChange: (value) => setTheme(value as Theme),
  })

  // The logo uploads to ImgBB and is stored as a URL, exactly like in Settings.
  // When uploads are switched off (no ImgBB key configured for the build) the
  // picker renders disabled with a hint rather than silently failing — a logo
  // is optional and can be added later.
  const logo = imagePicker({
    value: null,
    label: 'Shop logo',
    previewClass: 'h-20 w-20',
    validate: (file) => validateImageFile(file),
    ...(imageUploadsEnabled()
      ? {
          upload: async (file, onProgress) => {
            const uploaded = await uploadImage(file, { name: 'Shop logo', onProgress })
            return { url: uploaded.url, thumbUrl: uploaded.thumbUrl }
          },
        }
      : { disabledHint: t('settings.shopLogoDisabled') }),
  })

  shopName.dataset.field = 'name'
  shopType.dataset.field = 'shopType'
  localeSelect.dataset.field = 'locale'
  currency.dataset.field = 'currency'
  timezone.dataset.field = 'timezone'
  themeSelect.dataset.field = 'theme'

  const errorSlot = h('p', { class: 'hidden text-sm text-danger', role: 'alert', dataset: { field: 'error' } })
  const submit = button(t('onboarding.submit'), { variant: 'primary', fullWidth: true, size: 'lg' })

  const showError = (message: string): void => {
    errorSlot.textContent = message
    errorSlot.classList.remove('hidden')
  }

  const go = async (): Promise<void> => {
    errorSlot.classList.add('hidden')
    if (!shopName.value.trim()) {
      showError(t('onboarding.errorName'))
      return
    }
    if (!shopType.value) {
      showError(t('onboarding.errorType'))
      return
    }
    submit.disabled = true
    submit.textContent = t('onboarding.submitting')

    // Upload the logo (if any) before provisioning, so a failed upload is
    // reported here rather than after the shop already exists.
    let logoUrl: string | null = null
    try {
      logoUrl = await logo.commit()
    } catch {
      submit.disabled = false
      submit.textContent = t('onboarding.submit')
      showError(t('settings.shopLogoDisabled'))
      return
    }

    const result = await provisionShop({
      shopName: shopName.value,
      shopType: shopType.value,
      locale: localeSelect.value,
      currency: currency.value,
      timezone: timezone.value,
      logoUrl,
    })
    if (result.ok) {
      clearDraft('onboarding.shop')
      options.onDone()
      return
    }
    submit.disabled = false
    submit.textContent = t('onboarding.submit')
    showError(result.error)
  }

  submit.addEventListener('click', () => void go())
  shopName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void go()
  })

  const el = h(
    'div',
    {
      // Centred in the space under the topbar rather than pinned to the top:
      // on a 6" phone a short form floating above half a screen of nothing
      // reads as a broken page. dvh, not vh — mobile browser chrome moves.
      class:
        'mx-auto flex min-h-[calc(100dvh-7rem)] w-full max-w-md ' +
        'items-center justify-center p-4 sm:p-6',
    },
    h(
      'div',
      { class: 'rounded-xl border border-border bg-surface p-6 shadow-sm' },
      h('h1', { class: 'text-xl font-semibold text-content', text: t('onboarding.title') }),
      h('p', {
        class: 'mt-1 text-sm text-content-muted',
        text: t('onboarding.subtitle'),
      }),
      h(
        'div',
        { class: 'mt-5 space-y-4' },
        field(t('settings.shopName'), shopName, { required: true }),
        field(t('onboarding.shopType'), shopType, {
          required: true,
          hint: t('onboarding.shopTypeHint'),
        }),
        h(
          'div',
          { class: 'grid gap-4 sm:grid-cols-2' },
          field(t('settings.language'), localeSelect, { required: true, hint: t('settings.languageHint') }),
          field(t('settings.currency'), currency, { required: true, hint: t('settings.currencyHint') }),
          field(t('settings.timezone'), timezone, { required: true, hint: t('settings.timezoneHint') }),
          field(t('settings.theme'), themeSelect, { hint: t('settings.themeHint') })
        ),
        field(t('settings.shopLogo'), logo.root,
          imageUploadsEnabled() ? {} : { hint: t('settings.shopLogoDisabled') }
        )
      ),
      errorSlot,
      h('div', { class: 'mt-5' }, submit)
    )
  )

  bindDrafts(el, 'onboarding.shop')
  return el
}
