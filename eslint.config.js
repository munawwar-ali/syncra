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
    files: ['**/*.config.ts', '**/*.config.js'],
    rules: { 'import/no-default-export': 'off' },
  },
);
