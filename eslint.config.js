import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'docs/book/**', 'compiler/build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['apps/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // browser code (web clients): DOM globals, no node builtins
    files: ['apps/*-web/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        DataView: 'readonly',
        setTimeout: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        crypto: 'readonly',
        process: 'readonly', // vite.config.js reads env at build time
      },
    },
  },
);
