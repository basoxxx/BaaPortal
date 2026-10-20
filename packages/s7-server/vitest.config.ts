import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 's7-server', environment: 'node', include: ['test/**/*.test.ts'] },
});
