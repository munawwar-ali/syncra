import { defineConfig } from '@playwright/test';

const API_PORT = 18080;
const WEB_PORT = 15173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
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
      // Docker-free stack: embedded Postgres + in-memory Redis stand-in + a sync node in demo mode.
      command: 'pnpm --dir ../.. exec tsx scripts/local-stack.ts',
      env: { PORT: String(API_PORT), LOCAL_PG_PORT: '54331' },
      url: `http://localhost:${String(API_PORT)}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite --port ${String(WEB_PORT)} --strictPort`,
      env: { SYNCRA_API: `http://localhost:${String(API_PORT)}` },
      url: `http://localhost:${String(WEB_PORT)}`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
