import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 's7comm', environment: 'node', include: ['test/**/*.test.ts'] },
});
