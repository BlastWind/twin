import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Threaded wasm (wasm-bindgen-rayon, Phase 2.5) needs `SharedArrayBuffer`, which
 * the browser only hands to a cross-origin-isolated page. Everything the app
 * fetches - PMTiles, wasm, graph chunks - is same-origin, so `require-corp`
 * costs nothing here; the one external resource is the glyph URL, fetched in
 * CORS mode (which satisfies `require-corp`) and degrading to unlabelled
 * symbols rather than a broken map if it is ever refused.
 */
const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const

export default defineConfig({
  plugins: [react()],
  server: { headers: CROSS_ORIGIN_ISOLATION },
  preview: { headers: CROSS_ORIGIN_ISOLATION },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes('node_modules/maplibre-gl') ? 'maplibre'
          : id.includes('node_modules/deck.gl') || id.includes('node_modules/@deck.gl') ? 'deckgl'
          : undefined,
      },
    },
  },
})
