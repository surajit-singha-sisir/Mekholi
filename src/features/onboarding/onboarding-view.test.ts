/**
 * Onboarding screen — it now sets up more than a name and a type.
 *
 * The recovery screen for an account with no shop grew the preferences a
 * shopkeeper would otherwise have to hunt for straight afterwards: language,
 * currency, time zone, appearance and a logo. These tests hold that contract:
 * the extra controls render, the time zone defaults to the device's, language
 * applies to the device the moment it changes, and everything the owner picked
 * reaches `provisionShop` — while an empty name still refuses to submit.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { onboardingView } from './onboarding-view'
import { locale, resetI18nForTests } from '../../shared/i18n'
import { resetThemeForTests, theme } from '../../shared/theme'
import { deviceTimeZone } from '../../shared/domain/timezones'

const provisionShop = vi.fn(async (_input: unknown) => ({ ok: true as const }))

vi.mock('../../app/platform/auth', () => ({
  provisionShop: (input: unknown) => provisionShop(input),
}))

vi.mock('../../app/images', () => ({
  imageUploadsEnabled: () => false,
  uploadImage: vi.fn(),
  validateImageFile: () => null,
}))

/** Let the submit handler's awaited promises settle. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

const fieldSelect = (root: HTMLElement, name: string): HTMLSelectElement =>
  root.querySelector(`select[data-field="${name}"]`) as HTMLSelectElement

/** The primary submit button, told apart from the logo picker's own button. */
const submitButton = (root: HTMLElement): HTMLButtonElement =>
  Array.from(root.querySelectorAll('button')).find((el) =>
    el.textContent?.includes('Create my shop')
  ) as HTMLButtonElement

describe('onboardingView', () => {
  beforeEach(() => {
    localStorage.clear()
    resetI18nForTests()
    resetThemeForTests()
    provisionShop.mockClear()
  })

  it('renders language, currency, time zone, appearance and logo controls', () => {
    const root = onboardingView({ onDone: vi.fn() })
    expect(fieldSelect(root, 'locale')).not.toBeNull()
    expect(fieldSelect(root, 'currency')).not.toBeNull()
    expect(fieldSelect(root, 'timezone')).not.toBeNull()
    expect(fieldSelect(root, 'theme')).not.toBeNull()
    // The logo picker's root is present even when uploads are switched off.
    expect(root.textContent).toContain('Shop logo')
  })

  it('defaults the time zone to the device zone and currency to BDT', () => {
    const root = onboardingView({ onDone: vi.fn() })
    expect(fieldSelect(root, 'timezone').value).toBe(deviceTimeZone())
    expect(fieldSelect(root, 'currency').value).toBe('BDT')
  })

  it('applies a language change to the device immediately', () => {
    const root = onboardingView({ onDone: vi.fn() })
    const localeSelect = fieldSelect(root, 'locale')
    expect(locale()).toBe('en')
    localeSelect.value = 'bn'
    localeSelect.dispatchEvent(new Event('change'))
    expect(locale()).toBe('bn')
  })

  it('applies a theme change to the device immediately', () => {
    const root = onboardingView({ onDone: vi.fn() })
    const themeSelect = fieldSelect(root, 'theme')
    themeSelect.value = 'dark'
    themeSelect.dispatchEvent(new Event('change'))
    expect(theme()).toBe('dark')
  })

  it('passes every picked preference to provisionShop and finishes', async () => {
    const onDone = vi.fn()
    const root = onboardingView({ onDone })

    const name = root.querySelector('input') as HTMLInputElement
    name.value = 'Rahim Store'
    const typeSelect = fieldSelect(root, 'shopType')
    const firstRealType = Array.from(typeSelect.options).find((option) => option.value !== '')
    typeSelect.value = firstRealType?.value ?? ''
    fieldSelect(root, 'locale').value = 'bn'
    fieldSelect(root, 'currency').value = 'USD'

    const submit = submitButton(root)
    submit.click()
    await settle()

    expect(provisionShop).toHaveBeenCalledTimes(1)
    const arg = provisionShop.mock.calls[0]?.[0] as Record<string, unknown>
    expect(arg.shopName).toBe('Rahim Store')
    expect(arg.locale).toBe('bn')
    expect(arg.currency).toBe('USD')
    expect(arg.timezone).toBe(deviceTimeZone())
    // Uploads are switched off in this suite, so the committed logo is null.
    expect(arg.logoUrl).toBeNull()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('refuses to submit without a shop name', async () => {
    const onDone = vi.fn()
    const root = onboardingView({ onDone })

    const submit = submitButton(root)
    submit.click()
    await settle()

    expect(provisionShop).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    const alert = root.querySelector('[data-field="error"]') as HTMLElement
    expect(alert.classList.contains('hidden')).toBe(false)
  })
})
