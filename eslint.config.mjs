import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '.ripplewitness/**', '**/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Plain-JS subjects and shims run under node but have no TS environment
  // declarations; no-undef false-positives on process/console/require there.
  // Those files are covered by execution tests instead of the linter.
  { files: ['**/*.js', '**/*.cjs', '**/*.mjs'], rules: { 'no-undef': 'off' } },
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
];
