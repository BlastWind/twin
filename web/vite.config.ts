import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
