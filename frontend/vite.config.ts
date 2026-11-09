import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        // Backend for `npm run dev`; override with VITE_API_TARGET (env var or .env.local)
        target: loadEnv(mode, process.cwd(), '').VITE_API_TARGET || 'http://localhost:3000',
        // Keep the browser's Host header so the backend's LAN-only setup check and CSRF checks see the real host
        changeOrigin: false,
        // Never set xfwd: X-Forwarded-* headers make the backend refuse setup as non-LAN
        xfwd: false,
        // Live printer status (Phase 2) uses a WebSocket upgrade on /api
        ws: true,
      },
    },
  },
}))
