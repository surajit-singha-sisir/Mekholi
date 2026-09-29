/**
 * Where the ImgBB key comes from.
 *
 * This is the file that decides whether a shop can put a photo on a product
 * at all, and it used to have exactly one answer: a `VITE_` variable baked in
 * at build time. That is why image uploads shipped switched off — nobody
 * rebuilds a deployed POS to turn on a picture, and the disabled hint told a
 * shopkeeper to edit an environment file.
 *
 * So what is protected here is the precedence: the shop's own key beats the
 * build default, clearing it falls back rather than going dark, the key
 * survives a reload so the first paint is not disabled, and one shop's key
 * does not follow the next shop signed in on the same till.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

/** The build-time value, made writable so both branches can be exercised. */
const mockEnv = vi.hoisted(() => ({ imgbbApiKey: '' }))
vi.mock('./env', () => ({ env: mockEnv }))

import {
  adoptImageUploadKey,
  imageKeySource,
  imageUploadKey,
  imageUploadsEnabled,
  resetImageKeyForTests,
  setImageUploadKey,
  IMGBB_SETTINGS_KEY,
} from './images'

const STORAGE_KEY = 'mekholi.imgbb.key'

describe('the ImgBB key in force', () => {
  beforeEach(() => {
    localStorage.clear()
    resetImageKeyForTests()
    mockEnv.imgbbApiKey = ''
  })

  it('is off when neither the build nor the shop has one', () => {
    expect(imageUploadsEnabled()).toBe(false)
    expect(imageKeySource()).toBe('none')
  })

  it('falls back to the key the build shipped with', () => {
    mockEnv.imgbbApiKey = 'build-key'
    expect(imageUploadsEnabled()).toBe(true)
    expect(imageUploadKey()).toBe('build-key')
    expect(imageKeySource()).toBe('build')
  })

  it('lets the shop override the build default', () => {
    mockEnv.imgbbApiKey = 'build-key'
    setImageUploadKey('shop-key')
    expect(imageUploadKey()).toBe('shop-key')
    expect(imageKeySource()).toBe('shop')
  })

  it('trims what was pasted — a stray space is not a different key', () => {
    setImageUploadKey('  spaced-key \n')
    expect(imageUploadKey()).toBe('spaced-key')
  })

  it('falls back rather than going dark when the shop clears its key', () => {
    mockEnv.imgbbApiKey = 'build-key'
    setImageUploadKey('shop-key')
    setImageUploadKey('')
    expect(imageUploadsEnabled()).toBe(true)
    expect(imageKeySource()).toBe('build')
  })

  it('switches uploads on without a reload', () => {
    expect(imageUploadsEnabled()).toBe(false)
    setImageUploadKey('shop-key')
    // The client is rebuilt, not reused: `enabled` is fixed at construction,
    // so a cached one would keep reporting the app has no key.
    expect(imageUploadsEnabled()).toBe(true)
  })

  it('mirrors the key to the device so the first paint is not disabled', () => {
    setImageUploadKey('shop-key')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('shop-key')
    setImageUploadKey(null)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})

describe('adopting the key from a shop profile', () => {
  beforeEach(() => {
    localStorage.clear()
    resetImageKeyForTests()
    mockEnv.imgbbApiKey = ''
  })

  it('takes the key out of the settings bag', () => {
    adoptImageUploadKey({ [IMGBB_SETTINGS_KEY]: 'from-the-shop', receiptShowLogo: true })
    expect(imageUploadKey()).toBe('from-the-shop')
    expect(imageKeySource()).toBe('shop')
  })

  it('does not let one shop’s key follow the next shop on the same till', () => {
    setImageUploadKey('first-shop-key')
    adoptImageUploadKey({ receiptShowLogo: true })
    expect(imageKeySource()).toBe('none')
    expect(imageUploadsEnabled()).toBe(false)
  })

  it('survives a bag that is missing or malformed', () => {
    setImageUploadKey('a-key')
    adoptImageUploadKey(null)
    expect(imageKeySource()).toBe('none')

    setImageUploadKey('a-key')
    adoptImageUploadKey({ [IMGBB_SETTINGS_KEY]: 42 })
    expect(imageKeySource()).toBe('none')
  })
})
