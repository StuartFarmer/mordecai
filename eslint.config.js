import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'docs/book/**', 'compiler/build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // browser code (frontier web client): DOM globals, no node builtins
    files: ['apps/frontier-web/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        DataView: 'readonly',
        setTimeout: 'readonly',
        process: 'readonly', // vite.config.js reads env at build time
      },
    },
  },
);
