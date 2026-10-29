import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', 'eslint.config.js'] },
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
    files: ['**/*.config.ts', '**/*.config.js', '**/global-setup.ts'],
    rules: { 'import/no-default-export': 'off' },
  },
);
