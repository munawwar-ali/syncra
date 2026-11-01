import { defineConfig } from 'vitest/config';

// e2e/ holds Playwright specs; they run through `pnpm test:e2e`.
export default defineConfig({ test: { include: ['src/**/*.test.{ts,tsx}'] } });
