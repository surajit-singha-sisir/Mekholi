import { describe, expect, it } from 'vitest'
import { workerSource } from '../../tools/pwa-service-worker'

describe('generated PWA service worker', () => {
  it('versions and precaches the complete emitted shell', () => {
    const source = workerSource('abc123', ['./index.html', './assets/app-123.js'])
    expect(source).toContain('mekholi-shell-abc123')
    expect(source).toContain('./assets/app-123.js')
    expect(source).toContain("request.mode === 'navigate'")
    expect(source).toContain("url.origin !== scope.origin")
    expect(source).toContain("event.data.type === 'SKIP_WAITING'")
  })

  it('roots cached deep-link HTML at the worker scope', () => {
    const source = workerSource('v1', ['./index.html'])
    expect(source).toContain("html.replace('<base href=\"./\">'")
    expect(source).toContain('self.registration.scope')
  })
})
