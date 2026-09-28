import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'

const PUBLIC_SHELL = [
  './',
  './index.html',
  './404.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/apple-touch-icon.png',
  './icons/mekholi-192.png',
  './icons/mekholi-512.png',
  './icons/mekholi-maskable-512.png',
]

/**
 * Generate a service worker from Vite's actual output list. Hashed chunks are
 * therefore precached on first installation instead of merely being cached if
 * the user happens to open every lazy-loaded screen while online.
 */
export function pwaServiceWorker(): Plugin {
  return {
    name: 'mekholi-pwa-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle)
        .filter((file) => !file.endsWith('.map') && file !== 'sw.js')
        .map((file) => `./${file}`)
      const shell = [...new Set([...PUBLIC_SHELL, ...emitted])].sort()
      const version = createHash('sha256').update(shell.join('\n')).digest('hex').slice(0, 16)

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: workerSource(version, shell),
      })
    },
  }
}

export function workerSource(version: string, shell: string[]): string {
  return `/* Mekholi app-shell service worker. Generated; do not edit. */
const CACHE = ${JSON.stringify(`mekholi-shell-${version}`)};
const SHELL = ${JSON.stringify(shell)};
const INDEX = './index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('mekholi-shell-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function shellResponse(response) {
  return response.text().then((html) => {
    const base = new URL('./', self.registration.scope).pathname;
    const rooted = html.replace('<base href="./">', '<base href="' + base + '">');
    return new Response(rooted, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Mekholi-Shell': '1' },
    });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) return response;
          return caches.match(INDEX).then((cached) => cached ? shellResponse(cached) : response);
        })
        .catch(() => caches.match(INDEX).then((cached) => {
          if (!cached) throw new Error('Mekholi app shell is unavailable');
          return shellResponse(cached);
        }))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    }))
  );
});
`
}
