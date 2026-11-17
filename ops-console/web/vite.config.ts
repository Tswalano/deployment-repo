import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :9200; the browser talks to Vite, which proxies /api.
// The proxy rewrites Origin so the API's CSRF check (ALLOWED_ORIGINS) accepts dev requests.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.OPS_API_PORT || 9200}`,
        changeOrigin: true,
        headers: { origin: 'http://localhost:5173' },
        ws: true,   // browser terminal (WebSocket)
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
