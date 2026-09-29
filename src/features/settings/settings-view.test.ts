/**
 * Settings screen — it must actually stop loading.
 *
 * This screen shipped stuck on its spinner: `render()` ran while the `loading`
 * flag was still true, and the flag was only cleared afterwards in `finally`,
 * so the one redraw the load ever performed drew the spinner and nothing
 * replaced it. Owners saw an animation and no settings.
 *
 * These tests hold the loaded state in place: the shop name reaches the form,
 * a failure in a supporting card does not take the page with it, and a failure
 * in the profile itself says so instead of spinning.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { settingsView } from './settings-view'
import { locale, resetI18nForTests, t } from '../../shared/i18n'
import { resetThemeForTests, theme } from '../../shared/theme'

const settingsRow = {
  id: 'org-1',
  name: 'Sisir Store',
  slug: 'sisir-store',
  currency: 'BDT',
  timezone: 'Asia/Dhaka',
  locale: 'en',
  logoUrl: null as string | null,
  settings: { receiptFooter: 'Thank you', receiptShowLogo: true },
}

const getSettings = vi.fn(async () => settingsRow)
const updateSettings = vi.fn(async () => settingsRow)
const listAllTaxes = vi.fn(async () => [
  { id: 't-1', name: 'VAT', rate: 15, is_inclusive: false, is_active: true },
])
const listAllPaymentMethods = vi.fn(async () => [
  { id: 'm-1', name: 'Cash', type: 'cash', is_cash: true, is_active: true },
])

vi.mock('../../app/data', () => ({
  getRepositories: () => ({
    organization: { getSettings, updateSettings },
    catalog: { listAllTaxes, listAllPaymentMethods, updatePaymentMethod: vi.fn(), createTax: vi.fn(), updateTax: vi.fn() },
  }),
}))

vi.mock('../../app/state/session', () => ({
  can: () => true,
}))

/**
 * The image layer is stubbed rather than exercised: this file is about the
 * settings screen, and a real client would reach for `localStorage` and the
 * network. `imageKeySource` is the one knob the ImgBB card reads, so the
 * tests below drive it to check the status line.
 */
let keySource: 'shop' | 'build' | 'none' = 'none'
const setImageUploadKey = vi.fn()
const probeImageUploadKey = vi.fn(async (_key: string) => ({
  ok: true,
  message: 'That key works.',
}))

vi.mock('../../app/images', () => ({
  IMGBB_SETTINGS_KEY: 'imgbbApiKey',
  adoptImageUploadKey: vi.fn(),
  imageKeySource: () => keySource,
  imageUploadKey: () => '',
  imageUploadsEnabled: () => false,
  probeImageUploadKey: (key: string) => probeImageUploadKey(key),
  setImageUploadKey: (key: string | null) => setImageUploadKey(key),
  uploadImage: vi.fn(),
  validateImageFile: () => null,
}))

/** The view loads asynchronously; let its promises settle. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('settingsView', () => {
  beforeEach(() => {
    localStorage.clear()
    resetI18nForTests()
    resetThemeForTests()
    getSettings.mockClear()
    updateSettings.mockClear()
    setImageUploadKey.mockClear()
    probeImageUploadKey.mockClear()
    keySource = 'none'
    listAllTaxes.mockClear().mockResolvedValue([
      { id: 't-1', name: 'VAT', rate: 15, is_inclusive: false, is_active: true },
    ])
    listAllPaymentMethods.mockClear().mockResolvedValue([
      { id: 'm-1', name: 'Cash', type: 'cash', is_cash: true, is_active: true },
    ])
  })

  it('replaces the spinner with the shop profile once loaded', async () => {
    const root = settingsView()
    expect(root.querySelector('[data-state="loading"]')).not.toBeNull()

    await settle()

    expect(root.querySelector('[data-state="loading"]')).toBeNull()
    expect(root.textContent).toContain('Shop details')
    const nameInput = root.querySelector('input') as HTMLInputElement
    expect(nameInput.value).toBe('Sisir Store')
  })

  it('draws the taxes and payment methods it was given', async () => {
    const root = settingsView()
    await settle()
    expect(root.textContent).toContain('VAT')
    expect(root.textContent).toContain('Cash')
  })

  it('renders the shop logo field', async () => {
    const root = settingsView()
    await settle()
    expect(root.textContent).toContain('Shop logo')
  })

  it('still renders the page when a supporting card fails', async () => {
    listAllTaxes.mockRejectedValueOnce(new Error('permission denied for table taxes'))
    const root = settingsView()
    await settle()

    expect(root.querySelector('[data-state="loading"]')).toBeNull()
    expect(root.textContent).toContain('Shop details')
    expect(root.textContent).toContain('Some settings could not be loaded')
    // The payment card survived its sibling's failure.
    expect(root.textContent).toContain('Cash')
  })

  it('switches the app language the moment the select changes', async () => {
    const root = settingsView()
    await settle()

    const select = root.querySelector('select[data-field="locale"]') as HTMLSelectElement
    expect(select.value).toBe('en')
    select.value = 'bn'
    select.dispatchEvent(new Event('change'))

    expect(locale()).toBe('bn')
    expect(document.documentElement.lang).toBe('bn')
    // The shell redraws from `t()`, so the next render is Bangla.
    expect(t('settings.title')).toBe('সেটিংস')
  })

  it('adopts the language the shop saved, without being asked', async () => {
    getSettings.mockResolvedValueOnce({ ...settingsRow, locale: 'bn' })
    settingsView()
    await settle()
    expect(locale()).toBe('bn')
  })

  it('keeps the language the user just picked, instead of reloading the old one', async () => {
    // The bug: every render re-read the shop row and re-applied its locale,
    // so choosing বাংলা switched the language, redrew the screen, and the
    // redraw put English straight back. The select flicked and nothing
    // changed.
    getSettings.mockResolvedValue({ ...settingsRow, locale: 'en' })
    const root = settingsView()
    await settle()

    const select = root.querySelector('select[data-field="locale"]') as HTMLSelectElement
    select.value = 'bn'
    select.dispatchEvent(new Event('change'))
    expect(locale()).toBe('bn')

    // A second screen mounts (the shell redraws on a language change) and
    // loads the shop profile again, which still says `en`.
    const second = settingsView()
    await settle()
    expect(locale()).toBe('bn')
    expect((second.querySelector('select[data-field="locale"]') as HTMLSelectElement).value).toBe('bn')
  })

  it('offers currencies and time zones as lists, not spelling tests', async () => {
    const root = settingsView()
    await settle()

    const currency = root.querySelector('select[data-field="currency"]') as HTMLSelectElement
    expect(currency).not.toBeNull()
    expect(currency.value).toBe('BDT')
    expect(currency.options.length).toBeGreaterThan(50)
    expect([...currency.options].some((option) => option.value === 'USD')).toBe(true)
    expect([...currency.options].find((option) => option.value === 'BDT')?.text).toContain('৳')

    const timezone = root.querySelector('select[data-field="timezone"]') as HTMLSelectElement
    expect(timezone.value).toBe('Asia/Dhaka')
    expect(timezone.options.length).toBeGreaterThan(20)
    expect([...timezone.options].find((option) => option.value === 'Asia/Dhaka')?.text).toContain('UTC+06:00')
  })

  it('keeps a saved value that this build has never heard of', async () => {
    getSettings.mockResolvedValueOnce({ ...settingsRow, currency: 'ZZZ', timezone: 'Mars/Olympus' })
    const root = settingsView()
    await settle()
    expect((root.querySelector('select[data-field="currency"]') as HTMLSelectElement).value).toBe('ZZZ')
    expect((root.querySelector('select[data-field="timezone"]') as HTMLSelectElement).value).toBe('Mars/Olympus')
  })

  /**
   * Image uploads used to be unreachable: the ImgBB key was a build-time
   * `VITE_` variable, so every deployment nobody had rebuilt drew disabled
   * pickers and told the shopkeeper to edit an environment file. These hold
   * the fix in place — a key an owner can type, test and save.
   */
  describe('the ImgBB card', () => {
    it('never tells a shopkeeper to set an environment variable', async () => {
      const root = settingsView()
      await settle()
      expect(root.textContent).not.toContain('VITE_')
    })

    it('offers a key field and says uploads are off when there is none', async () => {
      keySource = 'none'
      const root = settingsView()
      await settle()
      expect(root.textContent).toContain(t('settings.imageUploads'))
      expect(root.querySelector('input[data-field="imgbbApiKey"]')).not.toBeNull()
      const status = root.querySelector('[data-field="imgbbStatus"]')
      expect(status?.textContent).toBe(t('settings.imgbbOff'))
    })

    it('credits the shop’s own key once one is in force', async () => {
      keySource = 'shop'
      const root = settingsView()
      await settle()
      expect(root.querySelector('[data-field="imgbbStatus"]')?.textContent).toBe(
        t('settings.imgbbOnShop')
      )
    })

    it('saves the key into the shop settings and switches uploads on', async () => {
      const root = settingsView()
      await settle()
      const keyField = root.querySelector('input[data-field="imgbbApiKey"]') as HTMLInputElement
      keyField.value = '  abc123  '

      const save = [...root.querySelectorAll('button')].filter((b) =>
        b.textContent?.includes(t('settings.save'))
      )
      // Two save buttons on the page; the ImgBB card owns the last one.
      save[save.length - 1]?.click()
      await settle()

      expect(updateSettings).toHaveBeenCalledWith({
        settings: expect.objectContaining({ imgbbApiKey: 'abc123' }),
      })
      // Trimmed, and handed to the image layer so photos work without a reload.
      expect(setImageUploadKey).toHaveBeenCalledWith('abc123')
    })

    it('tests a typed key before it is saved over a working one', async () => {
      const root = settingsView()
      await settle()
      const keyField = root.querySelector('input[data-field="imgbbApiKey"]') as HTMLInputElement
      keyField.value = 'candidate-key'

      const test = [...root.querySelectorAll('button')].find((b) =>
        b.textContent?.includes(t('settings.imgbbTest'))
      )
      test?.click()
      await settle()

      expect(probeImageUploadKey).toHaveBeenCalledWith('candidate-key')
      expect(updateSettings).not.toHaveBeenCalled()
    })
  })

  it('keeps the logo preview square', async () => {
    const root = settingsView()
    await settle()
    const box = root.querySelector('.aspect-square')
    expect(box).not.toBeNull()
    expect(box?.className).toContain('h-20')
    expect(box?.className).toContain('w-20')
  })

  it('switches the theme from the appearance card', async () => {
    const root = settingsView()
    await settle()

    expect(root.textContent).toContain('Appearance')
    const themeSelect = root.querySelector('select[data-field="theme"]') as HTMLSelectElement
    expect(themeSelect.value).toBe('system')
    expect([...themeSelect.options].map((option) => option.value)).toEqual(['system', 'light', 'dark'])

    themeSelect.value = 'dark'
    themeSelect.dispatchEvent(new Event('change'))
    expect(theme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('says so when the shop profile itself cannot be read', async () => {
    getSettings.mockRejectedValueOnce(new Error('network down'))
    const root = settingsView()
    await settle()

    expect(root.querySelector('[data-state="loading"]')).toBeNull()
    expect(root.textContent).toContain('Settings could not be loaded')
  })
})
