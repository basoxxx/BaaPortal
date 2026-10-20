import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 's7bench',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
