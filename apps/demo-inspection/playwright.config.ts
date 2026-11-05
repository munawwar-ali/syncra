import { defineConfig } from '@playwright/test';

const API_PORT = 18082;
const WEB_PORT = 15175;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // PW_CHANNEL=msedge|chrome drives an installed browser when 'playwright install' is unavailable.
  use: {
    channel: process.env.PW_CHANNEL,
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --dir ../.. exec tsx scripts/local-stack.ts',
      env: { PORT: String(API_PORT), LOCAL_PG_PORT: '54333' },
      url: `http://localhost:${String(API_PORT)}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      // The service worker only exists in a production build, so test the built app.
      command: `pnpm exec vite build --mode e2e && pnpm exec vite preview --port ${String(WEB_PORT)} --strictPort`,
      env: { SYNCRA_API: `http://localhost:${String(API_PORT)}` },
      url: `http://localhost:${String(WEB_PORT)}`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
