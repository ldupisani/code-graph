import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: false,
      },
      // Storybook's story index, for the in-graph story embeds
      // (src/render/storybookOverlay.ts). Proxied because a direct
      // cross-origin fetch of :6006/index.json would need CORS; the
      // story IFRAMES go straight to :6006 (iframes don't need it).
      '/sb-index': {
        target: 'http://127.0.0.1:6006',
        rewrite: () => '/index.json',
        configure: (proxy) => {
          // Storybook being DOWN is an expected state the client
          // handles (overlays show wireframe-only and quietly retry
          // every 10s) — answer 503 instead of letting vite log a
          // proxy-error stack trace per probe.
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
            }
            res.end('{"error":"storybook not running"}');
          });
        },
      },
    },
  },
});
