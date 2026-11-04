import { defineConfig } from '@playwright/test';

const API_PORT = 18081;
const WEB_PORT = 15174;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
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
      // Docker-free stack: embedded Postgres, in-memory Redis stand-in, one node, and the worker jobs in-process.
      command: 'pnpm --dir ../.. exec tsx scripts/local-stack.ts',
      env: {
        PORT: String(API_PORT),
        LOCAL_PG_PORT: '54332',
        WEBHOOK_ALLOW_PRIVATE: 'true', // the spec receives webhooks on localhost
        CHECKPOINT_INTERVAL_MS: '300',
        LOG_LEVEL: 'error',
      },
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
