import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "rw-e2e-home-"));

export default defineConfig({
  testDir: "./e2e",
  timeout: 240000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: [
    {
      command: "corepack pnpm --filter @ripplewitness/server run dev",
      port: 4400,
      timeout: 90000,
      reuseExistingServer: !process.env.CI,
      env: { ...process.env, RIPPLEWITNESS_HOME: home, RIPPLEWITNESS_PORT: "4400", META_API_KEY: "", RIPPLEWITNESS_AGENT_SESSION: "stub" } as Record<string, string>,
    },
    {
      command: "corepack pnpm --filter @ripplewitness/web run dev",
      port: 5173,
      timeout: 90000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
