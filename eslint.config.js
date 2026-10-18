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
);
