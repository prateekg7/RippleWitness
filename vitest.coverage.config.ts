import { defineConfig } from 'vitest/config';

// Coverage gate (TESTS_AND_BUGS.md §8.2): unit + integration suites with the
// repo-wide floor. Per-package bars (core ≥90/90, crossexam ≥90/85,
// replay ≥65/70) are read off the text report; the enforced gate is the
// §8.2 overall floor. Needs localhost (integration); run unsandboxed.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 120000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.int.test.ts', '**/fixtures/**', '**/node_modules/**'],
      thresholds: { lines: 70, branches: 70 },
    },
  },
});
