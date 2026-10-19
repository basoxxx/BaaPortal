import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 's7-types', environment: 'node', include: ['test/**/*.test.ts'] },
});
