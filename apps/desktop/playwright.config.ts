import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  workers: 1,
  expect: { timeout: 10_000 },
  use: { actionTimeout: 10_000 },
});
