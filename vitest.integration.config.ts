import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.int.test.ts"],
    testTimeout: 120000,
    // Integration tests spawn localhost servers on shared preferred ports;
    // run files sequentially so port resolution never races.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
