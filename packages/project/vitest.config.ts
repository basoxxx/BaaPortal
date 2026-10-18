import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'project', environment: 'node', include: ['test/**/*.test.ts'] },
});
