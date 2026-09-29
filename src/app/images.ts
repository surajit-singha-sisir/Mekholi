/**
 * The app's one image uploader, and the one place the ImgBB key is resolved.
 *
 * `shared/images/imgbb.ts` knows how to talk to ImgBB but deliberately knows
 * nothing about this app's configuration. This file is the join: every screen
 * calls `uploadImage()` and no feature ever constructs its own client.
 *
 * ## Why the key is not just an env var
 *
 * It used to be only `VITE_IMGBB_API_KEY`, and that made image uploads
 * unreachable in practice. A `VITE_` value is baked in at build time, so a
 * shop that wanted product photos had to get someone to edit `.env`, rebuild
 * and redeploy — and until then every picker in the app rendered disabled,
 * telling a shopkeeper to "set VITE_IMGBB_API_KEY", which is not a sentence
 * they can act on. A feature nobody can switch on is a feature that is not
 * there.
 *
 * So the key now has three sources, in order:
 *
 *   1. **The shop** — `organizations.settings.imgbbApiKey`, typed into
 *      Settings by the owner. Saved once, and every device in that shop
 *      picks it up. No rebuild, no deploy.
 *   2. **The device cache** — the same key mirrored into `localStorage`, so
 *      the first paint after a reload already has uploads enabled instead of
 *      drawing disabled pickers until the settings request lands.
 *   3. **The build** — `VITE_IMGBB_API_KEY`, still honoured as the default
 *      for a self-hosted deployment that would rather ship its own key.
 *
 * The key stays public either way. ImgBB issues these for browser uploads:
 * it can upload and nothing else — it cannot read an account, delete other
 * images or bill anything (docs/15, spec §44). Storing it in a settings row
 * a shop's own staff can read gives nothing away that the bundle did not
 * already hand to anyone who opened devtools.
 */

import { env } from './env'
import {
  createImgbbClient,
  ImageUploadError,
  probeImgbbKey,
  validateImageFile,
  type ImgbbClient,
  type KeyProbeResult,
  type UploadedImage,
  type UploadOptions,
} from '../shared/images/imgbb'

/** Device mirror of the shop's key, so uploads are live on the first paint. */
const STORAGE_KEY = 'mekholi.imgbb.key'

/** Where the shop's key lives inside `organizations.settings` (a jsonb bag). */
export const IMGBB_SETTINGS_KEY = 'imgbbApiKey'

/** Which of the three sources is actually in force. */
export type ImageKeySource = 'shop' | 'build' | 'none'

function readStored(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const trimmed = (raw ?? '').trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    // Storage is refused in a locked-down WebView and in private mode. An
    // unreadable cache is not a reason to fail to start; the env key stands
    // until the shop's settings arrive.
    return null
  }
}

function writeStored(key: string | null): void {
  try {
    if (key === null) globalThis.localStorage?.removeItem(STORAGE_KEY)
    else globalThis.localStorage?.setItem(STORAGE_KEY, key)
  } catch {
    /* ignore — the key is re-adopted from the shop on the next load */
  }
}

/** The shop's key, once known. Null means "fall back to the build default". */
let override: string | null = readStored()
/** Built lazily and thrown away whenever the key changes. */
let client: ImgbbClient | null = null
/** Set only by tests, and always preferred when present. */
let testClient: ImgbbClient | null = null

function activeKey(): string {
  return override ?? env.imgbbApiKey
}

function imageClient(): ImgbbClient {
  if (testClient) return testClient
  client ??= createImgbbClient({ apiKey: activeKey() })
  return client
}

/** True when a key is configured. Screens use it to explain, not to crash. */
export function imageUploadsEnabled(): boolean {
  return imageClient().enabled
}

/** The key in force, for a settings screen to show back to its owner. */
export function imageUploadKey(): string {
  return activeKey()
}

/** Where the key in force came from, so Settings can say so plainly. */
export function imageKeySource(): ImageKeySource {
  if (override !== null && override.length > 0) return 'shop'
  if (env.imgbbApiKey.length > 0) return 'build'
  return 'none'
}

/**
 * Sets the shop's key.
 *
 * Passing an empty string or null removes it, which falls back to the build
 * default rather than switching uploads off outright — a self-hosted
 * deployment that shipped a key should keep working when a shop clears its
 * own.
 */
export function setImageUploadKey(key: string | null): void {
  const trimmed = (key ?? '').trim()
  const next = trimmed.length > 0 ? trimmed : null
  if (next === override) return
  override = next
  // Dropped, not mutated: `enabled` is fixed at construction, so a live
  // client cannot be told about a new key.
  client = null
  writeStored(next)
}

/**
 * Adopts the key out of an organization's settings bag.
 *
 * Called wherever the shop profile is already being fetched — the app shell
 * on boot, and the settings screen on load — so no extra round trip is spent
 * on it. The bag is authoritative: a shop with no key clears the device
 * cache, which is what stops one shop's key leaking into the next shop
 * signed in on the same till.
 */
export function adoptImageUploadKey(bag: Record<string, unknown> | null | undefined): void {
  const raw = bag?.[IMGBB_SETTINGS_KEY]
  setImageUploadKey(typeof raw === 'string' ? raw : null)
}

/** Uploads one image and resolves to its hosted URLs. */
export function uploadImage(file: File, options?: UploadOptions): Promise<UploadedImage> {
  return imageClient().upload(file, options)
}

/**
 * Checks a key by uploading a 1×1 pixel that expires in a minute.
 *
 * Deliberately takes the key as an argument rather than reading the one in
 * force: the owner needs to know whether the key they just typed works
 * *before* they save it over a working one.
 */
export function probeImageUploadKey(key: string): Promise<KeyProbeResult> {
  return probeImgbbKey({ apiKey: key })
}

/** Replaces the client. Tests only — production reads the sources above. */
export function setImageClientForTests(next: ImgbbClient | null): void {
  testClient = next
  client = null
}

/** Restores module state between tests. */
export function resetImageKeyForTests(): void {
  testClient = null
  client = null
  override = null
  writeStored(null)
}

export { ImageUploadError, validateImageFile }
export type { KeyProbeResult, UploadedImage, UploadOptions }
