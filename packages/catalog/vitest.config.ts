import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'catalog', environment: 'node', include: ['test/**/*.test.ts'] },
});
