import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '.ripplewitness/**', '**/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
