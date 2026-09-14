import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { IMAGERY_UPSTREAM } from './src/map/imagery'

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

/**
 * Dev/preview-only imagery proxy: `/imagery/{z}/{x}/{y}` -> VGIN's cached
 * ArcGIS MapServer, whose tile endpoint is the same XYZ scheme with the row and
 * column transposed. It exists for two reasons and neither survives to
 * production: the upstream sends no CORS/CORP headers, which a cross-origin
 * isolated page requires, and shipping means serving our own PMTiles anyway.
 */
const upstream = new URL(IMAGERY_UPSTREAM)

const IMAGERY_PROXY = {
  '/imagery': {
    target: upstream.origin,
    changeOrigin: true,
    rewrite: (path: string) => {
      const m = /^\/imagery\/(\d+)\/(\d+)\/(\d+)/.exec(path)
      return m ? `${upstream.pathname}/tile/${m[1]}/${m[3]}/${m[2]}` : path
    },
  },
} as const

export default defineConfig({
  plugins: [react()],
  server: { headers: CROSS_ORIGIN_ISOLATION, proxy: IMAGERY_PROXY },
  preview: { headers: CROSS_ORIGIN_ISOLATION, proxy: IMAGERY_PROXY },
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
