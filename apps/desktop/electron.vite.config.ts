import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// CSP rigida solo nelle build di produzione: in sviluppo il plugin React inietta uno script inline.
const productionCsp = {
  name: 'baa-production-csp',
  apply: 'build' as const,
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      },
      injectTo: 'head-prepend' as const,
    },
  ],
};

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), productionCsp],
  },
});
