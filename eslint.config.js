import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      '.superpowers/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Il nucleo di s7comm è neutro rispetto alla piattaforma: sockets e Node solo in src/node/.
    files: ['packages/s7comm/src/**/*.ts'],
    ignores: ['packages/s7comm/src/node/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'net', 'tls', 'dgram', 'http', 'https', 'fs', 'child_process'],
              message: 'Solo packages/s7comm/src/node/ può importare moduli di Node.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'import() dinamico vietato nel nucleo di s7comm.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: 'require() vietato nel nucleo di s7comm.',
        },
      ],
    },
  },
);
