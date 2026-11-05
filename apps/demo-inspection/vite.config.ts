import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const api = process.env.SYNCRA_API ?? 'http://localhost:8080';
const proxy = { '/demo': api, '/v1': { target: api, ws: true } };

// Same-origin to the sync node in dev and in `vite preview`, so there is no CORS and one URL.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The app shell is precached; /demo and /v1 must always reach the network (the SDK handles offline).
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        navigateFallbackDenylist: [/^\/demo/, /^\/v1/],
      },
      manifest: {
        name: 'Syncra Field Inspection',
        short_name: 'Inspections',
        description: 'Offline-first site inspections that sync when you are back online.',
        theme_color: '#1d4ed8',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'icon.svg', sizes: '192x192 512x512', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: '192x192 512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { proxy },
  preview: { proxy },
  build: { sourcemap: true },
});
