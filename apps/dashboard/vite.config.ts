import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.SYNCRA_API ?? 'http://localhost:8080';

// Same-origin in development too: the refresh cookie is scoped to /v1/auth and needs no CORS setup.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/v1': { target: api, ws: true } } },
  build: { sourcemap: true },
});
