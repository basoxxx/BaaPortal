import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Come nella build del main: i moduli che leggono il canale si importano anche nei test.
  define: { __BAA_PRERELEASE_BUILD__: true },
  test: { include: ['test/**/*.test.ts'] },
});
