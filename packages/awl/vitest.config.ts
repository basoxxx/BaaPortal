import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'awl', environment: 'node', include: ['test/**/*.test.ts'] },
});
