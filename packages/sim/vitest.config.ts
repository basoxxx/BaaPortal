import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'sim', environment: 'node', include: ['test/**/*.test.ts'] },
});
