import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'scl', environment: 'node', include: ['test/**/*.test.ts'] },
});
