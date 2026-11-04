import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'docs/**',
      'eslint.config.js',
      '**/postcss.config.js',
      '**/tailwind.config.js',
      // k6 scripts run in k6's own runtime (not Node, not in any tsconfig); syntax-checked with `node --check`.
      'loadtest/k6/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    rules: {
      'import/no-cycle': 'error',
      'import/no-default-export': 'error',
    },
  },
  {
    // Browser/Node/worker feature detection (navigator.onLine, BroadcastChannel, localStorage) looks
    // redundant against the DOM typings but is required at runtime.
    files: ['packages/client/src/**/*.ts'],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off' },
  },
  {
    // Integration tests read untyped JSON response bodies.
    files: ['apps/server/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // ioredis-mock ships no resolvable types under NodeNext.
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // React handlers like onClick={() => setOpen(false)} are idiomatic; axe's impact is a string union.
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    // Benchmark tooling: pragmatic style, results are checked by the runs themselves.
    files: ['loadtest/**/*.ts'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    files: ['**/*.config.ts', '**/*.config.js', '**/global-setup.ts', '**/*.d.ts'],
    rules: { 'import/no-default-export': 'off' },
  },
);
