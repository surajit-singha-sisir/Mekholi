/**
 * ImgBB image hosting — one client for every image the app uploads.
 *
 * Mekholi stores no binaries of its own. A product photo, a shop logo or a
 * supplier document is pushed to ImgBB from the browser and only the returned
 * URL is written to the database. That is a deliberate trade (docs/09): image
 * hosting is a solved problem, Supabase storage is quota'd, and a shop on a
 * phone line should not pay twice for the same bytes.
 *
 * Why this file exists rather than a `fetch()` inside one screen:
 *
 *   • Validation lives in one place. Type, size and emptiness are checked
 *     before a single byte leaves the device — a 12 MB photo rejected locally
 *     costs nothing, the same photo rejected by ImgBB costs the whole upload
 *     on a 2G connection.
 *   • Progress and cancellation are real. Uploads run over XMLHttpRequest so
 *     the UI can show bytes moving and an `AbortSignal` can stop them.
 *   • Failures are retried once on a *transport* error only. A rejected key or
 *     an oversized file is a permanent answer; retrying it is just a second
 *     way to waste a shop's data.
 *   • It is pure. No `app/` import, no `env` read — the key is injected. That
 *     keeps this layer testable and keeps `shared/` from depending on the app
 *     it serves (docs/03 §3).
 *
 * The key is an ImgBB *public* key. It is safe in the browser by ImgBB's own
 * design; it is not, and must never be treated as, a secret (spec §44).
 */

/** The endpoint. Versioned by ImgBB, so it is named once. */
export const IMGBB_ENDPOINT = 'https://api.imgbb.com/1/upload'

/** Formats ImgBB accepts and the app is willing to send. */
export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
] as const

/** ImgBB's own ceiling for a free upload is 32 MB; the app is stricter. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** What a screen gets back once an image is hosted. */
export interface UploadedImage {
  /** Direct link to the full-size image — this is what is stored. */
  readonly url: string
  /** Page-friendly link ImgBB serves with the right content type. */
  readonly displayUrl: string
  /** Small preview, useful for grids and receipts. */
  readonly thumbUrl: string
  /**
   * The one-time deletion link. Kept so a shop can undo an upload it did not
   * mean to make; ImgBB offers no other way to remove an image.
   */
  readonly deleteUrl: string
  readonly width: number
  readonly height: number
  readonly sizeBytes: number
}

export interface UploadOptions {
  /** Filename shown in the ImgBB dashboard. Defaults to the file's own name. */
  readonly name?: string
  /**
   * Seconds after which ImgBB deletes the image (60 … 15552000). Omit for a
   * permanent upload, which is what a product photo needs.
   */
  readonly expirationSeconds?: number
  /** 0 → 1 as bytes leave the device. Called at least once with 1 on success. */
  readonly onProgress?: (fraction: number) => void
  /** Cancels an upload in flight; the promise rejects with an abort error. */
  readonly signal?: AbortSignal
}

export interface ImgbbConfig {
  readonly apiKey: string
  /** Injected for tests. Defaults to the browser's XMLHttpRequest transport. */
  readonly transport?: UploadTransport
  /** Retries after a transport failure. Default 1, so two attempts at most. */
  readonly retries?: number
}

/**
 * The minimum a transport must do: POST a body to a URL, report progress, and
 * honour an abort. Abstracted so the client is testable in Node, where there
 * is no XMLHttpRequest and no need for one.
 */
export type UploadTransport = (request: {
  url: string
  body: FormData
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}) => Promise<{ status: number; body: string }>

/** Why an upload failed, so a caller can tell a user something true. */
export type ImageUploadReason =
  | 'not-configured'
  | 'empty'
  | 'unsupported-type'
  | 'too-large'
  | 'aborted'
  | 'network'
  | 'rejected'

export class ImageUploadError extends Error {
  readonly reason: ImageUploadReason

  constructor(reason: ImageUploadReason, message: string) {
    super(message)
    this.name = 'ImageUploadError'
    this.reason = reason
  }
}

// ── Validation ────────────────────────────────────────────────────────────

/** Human size, for a message a shopkeeper can act on. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Checks a file before it costs anything to send.
 *
 * @returns the problem as a sentence, or null when the file is fine.
 */
export function validateImageFile(file: File, maxBytes = MAX_IMAGE_BYTES): string | null {
  if (!file || file.size === 0) return 'That file is empty.'
  const type = (file.type || '').toLowerCase()
  if (!ACCEPTED_IMAGE_TYPES.includes(type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
    return 'Choose a PNG, JPG, WEBP, GIF or BMP image.'
  }
  if (file.size > maxBytes) {
    return `Images must be ${formatBytes(maxBytes)} or smaller — that one is ${formatBytes(file.size)}.`
  }
  return null
}

function assertValid(file: File, maxBytes: number): void {
  if (!file || file.size === 0) throw new ImageUploadError('empty', 'That file is empty.')
  const problem = validateImageFile(file, maxBytes)
  if (!problem) return
  const reason: ImageUploadReason = file.size > maxBytes ? 'too-large' : 'unsupported-type'
  throw new ImageUploadError(reason, problem)
}

// ── Response parsing ──────────────────────────────────────────────────────

interface ImgbbEnvelope {
  success?: boolean
  status?: number
  error?: { message?: string }
  data?: {
    url?: string
    display_url?: string
    size?: number | string
    width?: number | string
    height?: number | string
    delete_url?: string
    thumb?: { url?: string }
    medium?: { url?: string }
    image?: { url?: string }
  }
}

function toNumber(value: number | string | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return Number.isFinite(parsed) ? Number(parsed) : 0
}

/**
 * Turns an ImgBB reply into an `UploadedImage`, or throws with ImgBB's own
 * wording. Exported because the parsing — not the network — is the part worth
 * testing, and the part that breaks when ImgBB changes a field name.
 */
export function parseImgbbResponse(status: number, body: string): UploadedImage {
  let envelope: ImgbbEnvelope
  try {
    envelope = JSON.parse(body) as ImgbbEnvelope
  } catch {
    throw new ImageUploadError(
      status >= 500 ? 'network' : 'rejected',
      'The image host sent a reply the app could not read.'
    )
  }

  const url = envelope.data?.url ?? envelope.data?.display_url ?? envelope.data?.image?.url ?? ''
  if (status < 200 || status >= 300 || envelope.success !== true || !url) {
    const message = envelope.error?.message?.trim()
    if (status === 400 && message && /api key/i.test(message)) {
      throw new ImageUploadError(
        'rejected',
        'The ImgBB key was refused. Check it in Settings → Image uploads.'
      )
    }
    throw new ImageUploadError(
      status >= 500 ? 'network' : 'rejected',
      message && message.length > 0 ? message : 'The image upload was refused.'
    )
  }

  const displayUrl = envelope.data?.display_url ?? url
  return {
    url,
    displayUrl,
    thumbUrl: envelope.data?.thumb?.url ?? envelope.data?.medium?.url ?? displayUrl,
    deleteUrl: envelope.data?.delete_url ?? '',
    width: toNumber(envelope.data?.width),
    height: toNumber(envelope.data?.height),
    sizeBytes: toNumber(envelope.data?.size),
  }
}

/** Builds the request URL. The key is a query parameter, per ImgBB's API. */
export function imgbbUploadUrl(apiKey: string, expirationSeconds?: number): string {
  const params = new URLSearchParams({ key: apiKey })
  if (typeof expirationSeconds === 'number' && Number.isFinite(expirationSeconds)) {
    // ImgBB's accepted window. Anything outside it is an error, not a clamp,
    // so clamping here is kinder than letting the upload die at the far end.
    const clamped = Math.min(Math.max(Math.round(expirationSeconds), 60), 15552000)
    params.set('expiration', String(clamped))
  }
  return `${IMGBB_ENDPOINT}?${params.toString()}`
}

// ── Transport ─────────────────────────────────────────────────────────────

/**
 * The browser transport. XMLHttpRequest rather than `fetch` for one reason:
 * upload progress. `fetch` still cannot report bytes sent, and an owner
 * uploading a 4 MB photo over a shop's phone tether deserves a moving bar
 * instead of a frozen dialog.
 */
export const xhrTransport: UploadTransport = ({ url, body, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest === 'undefined') {
      reject(new ImageUploadError('network', 'This device cannot upload images.'))
      return
    }
    if (signal?.aborted) {
      reject(new ImageUploadError('aborted', 'The upload was cancelled.'))
      return
    }

    const request = new XMLHttpRequest()
    request.open('POST', url, true)
    request.responseType = 'text'

    const onAbort = (): void => request.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => signal?.removeEventListener('abort', onAbort)

    if (onProgress && request.upload) {
      request.upload.onprogress = (event: ProgressEvent): void => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(0.99, event.loaded / event.total))
        }
      }
    }
    request.onload = () => {
      done()
      onProgress?.(1)
      resolve({ status: request.status, body: String(request.responseText ?? '') })
    }
    request.onerror = () => {
      done()
      reject(new ImageUploadError('network', 'The image host could not be reached.'))
    }
    request.ontimeout = () => {
      done()
      reject(new ImageUploadError('network', 'The image upload timed out.'))
    }
    request.onabort = () => {
      done()
      reject(new ImageUploadError('aborted', 'The upload was cancelled.'))
    }

    request.send(body)
  })

// ── Client ────────────────────────────────────────────────────────────────

export interface ImgbbClient {
  /** True when a key is present; screens hide upload controls when it is not. */
  readonly enabled: boolean
  upload(file: File, options?: UploadOptions): Promise<UploadedImage>
}

/**
 * Builds a client bound to one key.
 *
 * A transport failure is retried once — a dropped packet on a shop's
 * connection is common and cheap to repeat. A refusal from ImgBB is never
 * retried: the answer will not change.
 */
export function createImgbbClient(config: ImgbbConfig): ImgbbClient {
  const apiKey = config.apiKey.trim()
  const transport = config.transport ?? xhrTransport
  const retries = Math.max(0, config.retries ?? 1)

  return {
    enabled: apiKey.length > 0,

    async upload(file: File, options: UploadOptions = {}): Promise<UploadedImage> {
      if (apiKey.length === 0) {
        throw new ImageUploadError(
          'not-configured',
          'Image uploads are switched off. Add an ImgBB key in Settings → Image uploads.'
        )
      }
      assertValid(file, MAX_IMAGE_BYTES)

      const url = imgbbUploadUrl(apiKey, options.expirationSeconds)
      let lastError: unknown = null

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (options.signal?.aborted) {
          throw new ImageUploadError('aborted', 'The upload was cancelled.')
        }
        // A fresh FormData per attempt: a consumed body cannot be re-sent.
        const body = new FormData()
        body.append('image', file)
        body.append('name', (options.name ?? file.name ?? 'image').replace(/\.[^.]+$/, '').slice(0, 120))

        try {
          const response = await transport({
            url,
            body,
            ...(options.onProgress ? { onProgress: options.onProgress } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          })
          return parseImgbbResponse(response.status, response.body)
        } catch (error) {
          lastError = error
          const reason = error instanceof ImageUploadError ? error.reason : 'network'
          if (reason !== 'network' || attempt === retries) throw error
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new ImageUploadError('network', 'The image upload failed.')
    },
  }
}

// ── Key probe ─────────────────────────────────────────────────────────────

/**
 * A 1×1 transparent PNG, 68 bytes on the wire.
 *
 * ImgBB publishes no "is this key valid?" endpoint — upload is the whole API.
 * So the only honest test of a key is an upload, and the only considerate one
 * is an upload this small: it costs a shop on a phone line nothing, and with
 * `expiration` set it deletes itself before anyone could find it.
 */
const PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** ImgBB's shortest permitted lifetime. The probe image needs no longer. */
export const PROBE_EXPIRY_SECONDS = 60

/** The 1×1 PNG as a `File`, built in memory — nothing is read from disk. */
export function imgbbProbeFile(): File {
  if (typeof atob !== 'function') {
    throw new ImageUploadError('network', 'This device cannot build the test image.')
  }
  const binary = atob(PROBE_PNG_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], 'mekholi-key-test.png', { type: 'image/png' })
}

/** The answer to "does this key work?", in words a shopkeeper can act on. */
export interface KeyProbeResult {
  readonly ok: boolean
  readonly message: string
}

/**
 * Tries one tiny upload and reports whether the key was accepted.
 *
 * Never retried. A key test that silently attempts twice turns a flaky
 * answer into a confident one, and the whole point of the button is to tell
 * the truth about a key before a shop trusts it with a photo.
 */
export async function probeImgbbKey(config: ImgbbConfig): Promise<KeyProbeResult> {
  const apiKey = config.apiKey.trim()
  if (apiKey.length === 0) {
    return { ok: false, message: 'Enter an ImgBB key first.' }
  }

  const client = createImgbbClient({
    apiKey,
    retries: 0,
    ...(config.transport ? { transport: config.transport } : {}),
  })

  try {
    await client.upload(imgbbProbeFile(), {
      name: 'mekholi-key-test',
      expirationSeconds: PROBE_EXPIRY_SECONDS,
    })
    return { ok: true, message: 'That key works. The test image deletes itself in a minute.' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The key could not be checked.',
    }
  }
}
