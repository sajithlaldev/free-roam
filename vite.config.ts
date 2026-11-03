import { defineConfig } from 'vite';

// VITE_BASE: the path the site is served from (GitHub Pages: '/<repo>/').
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
