import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the UI on 5180 and proxies the WebSocket to the Node server (default 3848).
// Build: emits static assets into web/dist, which the Node server serves directly.
const SERVER_PORT = process.env.SERVER_PORT || '3848';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      '/api': { target: `http://localhost:${SERVER_PORT}` },
    },
  },
  build: { outDir: 'dist' },
});
