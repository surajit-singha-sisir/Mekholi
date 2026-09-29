/**
 * ImgBB client tests.
 *
 * The network is not the interesting part — the rules around it are. What is
 * protected here is what a shop actually feels: a bad file is refused before
 * it costs data, a dropped connection is retried once, a refusal is not
 * retried at all, and a reply that changed shape produces a sentence rather
 * than `undefined` in the database.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  ACCEPTED_IMAGE_TYPES,
  createImgbbClient,
  formatBytes,
  ImageUploadError,
  imgbbProbeFile,
  imgbbUploadUrl,
  MAX_IMAGE_BYTES,
  parseImgbbResponse,
  probeImgbbKey,
  PROBE_EXPIRY_SECONDS,
  validateImageFile,
  type UploadTransport,
} from './imgbb'

/** A File standing in for a photo, without reading a real one from disk. */
function fakeFile(name: string, type: string, bytes: number): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

const OK_BODY = JSON.stringify({
  success: true,
  status: 200,
  data: {
    url: 'https://i.ibb.co/abc/rice.jpg',
    display_url: 'https://i.ibb.co/abc/rice-display.jpg',
    delete_url: 'https://ibb.co/abc/delete-token',
    width: '800',
    height: '600',
    size: 24680,
    thumb: { url: 'https://i.ibb.co/abc/rice-thumb.jpg' },
  },
})

describe('validateImageFile', () => {
  it('accepts every format the app advertises', () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(validateImageFile(fakeFile('photo', type, 1024))).toBeNull()
    }
  })

  it('refuses a PDF wearing an image name', () => {
    expect(validateImageFile(fakeFile('invoice.jpg', 'application/pdf', 2048))).toMatch(/PNG, JPG/)
  })

  it('refuses an empty file', () => {
    expect(validateImageFile(fakeFile('nothing.png', 'image/png', 0))).toMatch(/empty/i)
  })

  it('refuses a file over the ceiling, and says both sizes', () => {
    const problem = validateImageFile(fakeFile('huge.png', 'image/png', MAX_IMAGE_BYTES + 1))
    expect(problem).toMatch(/10.0 MB or smaller/)
  })
})

describe('formatBytes', () => {
  it('scales the unit to the number', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('imgbbUploadUrl', () => {
  it('carries the key as a query parameter', () => {
    expect(imgbbUploadUrl('abc123')).toBe('https://api.imgbb.com/1/upload?key=abc123')
  })

  it('escapes a key rather than trusting it', () => {
    expect(imgbbUploadUrl('a b&c')).toContain('key=a+b%26c')
  })

  it('clamps an expiry into the window ImgBB accepts', () => {
    expect(imgbbUploadUrl('k', 10)).toContain('expiration=60')
    expect(imgbbUploadUrl('k', 99999999)).toContain('expiration=15552000')
    expect(imgbbUploadUrl('k', 3600)).toContain('expiration=3600')
  })
})

describe('parseImgbbResponse', () => {
  it('reads the URLs a screen needs', () => {
    const image = parseImgbbResponse(200, OK_BODY)
    expect(image.url).toBe('https://i.ibb.co/abc/rice.jpg')
    expect(image.thumbUrl).toBe('https://i.ibb.co/abc/rice-thumb.jpg')
    expect(image.deleteUrl).toBe('https://ibb.co/abc/delete-token')
    expect(image.width).toBe(800)
    expect(image.height).toBe(600)
    expect(image.sizeBytes).toBe(24680)
  })

  it('falls back to the display URL when no thumbnail is offered', () => {
    const body = JSON.stringify({ success: true, data: { url: 'https://i.ibb.co/x.png' } })
    expect(parseImgbbResponse(200, body).thumbUrl).toBe('https://i.ibb.co/x.png')
  })

  it('repeats ImgBB’s own complaint rather than inventing one', () => {
    const body = JSON.stringify({ success: false, error: { message: 'Image file is empty' } })
    expect(() => parseImgbbResponse(400, body)).toThrowError(/Image file is empty/)
  })

  it('points at the screen that fixes it when the key is the problem', () => {
    const body = JSON.stringify({ error: { message: 'Invalid API key' } })
    try {
      parseImgbbResponse(400, body)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ImageUploadError)
      expect((error as ImageUploadError).reason).toBe('rejected')
      expect((error as ImageUploadError).message).toMatch(/Settings . Image uploads/)
    }
  })

  it('treats a 5xx as a network fault, which is the retryable kind', () => {
    try {
      parseImgbbResponse(503, 'gateway down')
      expect.unreachable()
    } catch (error) {
      expect((error as ImageUploadError).reason).toBe('network')
    }
  })

  it('refuses a 200 that carries no URL, instead of storing undefined', () => {
    expect(() => parseImgbbResponse(200, JSON.stringify({ success: true, data: {} }))).toThrow()
  })
})

describe('createImgbbClient', () => {
  const okTransport: UploadTransport = async () => ({ status: 200, body: OK_BODY })

  it('reports itself disabled without a key, and refuses to upload', async () => {
    const client = createImgbbClient({ apiKey: '  ', transport: okTransport })
    expect(client.enabled).toBe(false)
    await expect(client.upload(fakeFile('a.png', 'image/png', 10))).rejects.toThrowError(
      /Settings . Image uploads/
    )
  })

  it('uploads and returns the hosted URLs', async () => {
    const client = createImgbbClient({ apiKey: 'key', transport: okTransport })
    expect(client.enabled).toBe(true)
    const image = await client.upload(fakeFile('rice.png', 'image/png', 4096))
    expect(image.url).toBe('https://i.ibb.co/abc/rice.jpg')
  })

  it('sends the file under `image`, with a name stripped of its extension', async () => {
    let seen: FormData | null = null
    const client = createImgbbClient({
      apiKey: 'key',
      transport: async ({ body }) => {
        seen = body
        return { status: 200, body: OK_BODY }
      },
    })
    await client.upload(fakeFile('basmati rice.png', 'image/png', 4096))
    expect(seen).not.toBeNull()
    expect((seen as unknown as FormData).get('name')).toBe('basmati rice')
    expect((seen as unknown as FormData).get('image')).toBeInstanceOf(File)
  })

  it('never reaches the network for a file it can reject locally', async () => {
    const transport = vi.fn(okTransport)
    const client = createImgbbClient({ apiKey: 'key', transport })
    await expect(client.upload(fakeFile('doc.pdf', 'application/pdf', 100))).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it('retries once when the connection drops, because shop lines do', async () => {
    let calls = 0
    const client = createImgbbClient({
      apiKey: 'key',
      transport: async () => {
        calls += 1
        if (calls === 1) throw new ImageUploadError('network', 'offline')
        return { status: 200, body: OK_BODY }
      },
    })
    const image = await client.upload(fakeFile('a.png', 'image/png', 2048))
    expect(calls).toBe(2)
    expect(image.url).toContain('i.ibb.co')
  })

  it('does not retry a refusal — the answer will not change', async () => {
    const transport = vi.fn(async () => ({
      status: 400,
      body: JSON.stringify({ error: { message: 'Invalid API key' } }),
    }))
    const client = createImgbbClient({ apiKey: 'key', transport })
    await expect(client.upload(fakeFile('a.png', 'image/png', 2048))).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('gives up after the retry budget and reports the fault', async () => {
    const transport = vi.fn(async () => {
      throw new ImageUploadError('network', 'offline')
    })
    const client = createImgbbClient({ apiKey: 'key', transport, retries: 2 })
    await expect(client.upload(fakeFile('a.png', 'image/png', 2048))).rejects.toThrowError(/offline/)
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it('stops before sending when the caller already aborted', async () => {
    const transport = vi.fn(okTransport)
    const controller = new AbortController()
    controller.abort()
    const client = createImgbbClient({ apiKey: 'key', transport })
    await expect(
      client.upload(fakeFile('a.png', 'image/png', 2048), { signal: controller.signal })
    ).rejects.toThrowError(/cancelled/)
    expect(transport).not.toHaveBeenCalled()
  })
})

/**
 * The key probe.
 *
 * ImgBB has no "is this key valid?" endpoint, so the only honest test of a
 * key is an upload. What matters is that the test is cheap (one pixel), self
 * cleaning (it expires), truthful (never retried into a false pass) and
 * costs nothing when there is no key to test.
 */
describe('probeImgbbKey', () => {
  it('refuses an empty key without touching the network', async () => {
    const transport = vi.fn<UploadTransport>()
    const result = await probeImgbbKey({ apiKey: '   ', transport })
    expect(result.ok).toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })

  it('uploads one tiny pixel that deletes itself, and says the key works', async () => {
    const seen: string[] = []
    const transport: UploadTransport = async ({ url }) => {
      seen.push(url)
      return { status: 200, body: OK_BODY }
    }

    const result = await probeImgbbKey({ apiKey: 'good-key', transport })

    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('key=good-key')
    // Set, and set to ImgBB's shortest window: a key test must not leave an
    // image behind on someone's account.
    expect(seen[0]).toContain(`expiration=${PROBE_EXPIRY_SECONDS}`)
  })

  it('reports a refused key in ImgBB’s own words rather than throwing', async () => {
    const transport: UploadTransport = async () => ({
      status: 400,
      body: JSON.stringify({ error: { message: 'Invalid API key' } }),
    })
    const result = await probeImgbbKey({ apiKey: 'bad-key', transport })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Settings . Image uploads/)
  })

  it('never retries — a flaky pass is worse than an honest failure', async () => {
    const transport = vi.fn<UploadTransport>(async () => {
      throw new ImageUploadError('network', 'The image host could not be reached.')
    })
    const result = await probeImgbbKey({ apiKey: 'some-key', transport })
    expect(result.ok).toBe(false)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('builds a real 1×1 PNG, not a placeholder', () => {
    const file = imgbbProbeFile()
    expect(file.type).toBe('image/png')
    expect(file.size).toBeGreaterThan(0)
    // Whatever the probe sends must pass the app's own front door.
    expect(validateImageFile(file)).toBeNull()
  })
})
