import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'importers', environment: 'node', include: ['test/**/*.test.ts'] },
});
