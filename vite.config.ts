import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { pwaServiceWorker } from './tools/pwa-service-worker'

// `base: './'` so the built bundle works from any sub-path (GitHub Pages,
// a CDN prefix, or an Android WebView asset root) without a rebuild.
export default defineConfig({
  base: './',
  plugins: [pwaServiceWorker()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Dev server only, never shipped. Sandboxed preview environments proxy
    // through a generated hostname, and Vite's host check rejects unknown
    // hosts by default. There is no production surface here to protect.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep vendor code in its own chunk so app chunks stay small and
        // cache-friendly across deploys.
        manualChunks: {
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
})
