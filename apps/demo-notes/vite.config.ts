import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.SYNCRA_API ?? 'http://localhost:8080';

// The app talks to the sync node through the dev server so it is same-origin (no CORS, one URL).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/demo': api,
      '/v1': { target: api, ws: true },
    },
  },
  build: { sourcemap: true },
});
