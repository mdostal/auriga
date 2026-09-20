import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Dev-mode proxy to the Node API server (src/server/index.mjs), which
    // listens on PORT (default 8787) and serves GET /api/* only.
    proxy: {
      '/api': {
        target: process.env.AURIGA_API_PROXY_TARGET || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
