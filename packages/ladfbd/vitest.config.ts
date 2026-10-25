import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'ladfbd', environment: 'node', include: ['test/**/*.test.ts'] },
});
