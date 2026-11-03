import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runComputeSide } from "./runner.js";
import { REPLAY_ENV_DENY, describeSandbox, scrubEnv, unsetProxies } from "./sandbox.js";

describe("replay sandbox (SEC-01)", () => {
  afterEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
  });

  it("scrubs proxy vars from explicit env", () => {
    expect(scrubEnv({ PORT: "1", HTTP_PROXY: "http://x", http_proxy: "http://x", EMPTY: undefined })).toEqual({ PORT: "1" });
    expect(Object.keys(unsetProxies()).sort()).toEqual([...REPLAY_ENV_DENY].sort());
    expect(Object.values(unsetProxies()).every((v) => v === undefined)).toBe(true);
  });

  it("reports capabilities honestly", () => {
    const r = describeSandbox();
    expect(r.enforcement).toBe("mock-flag");
    expect(typeof r.unshare).toBe("boolean");
    expect(typeof r.docker).toBe("boolean");
  });

  it("subject compute sees no inherited proxy and mock mode", async () => {
    process.env.HTTP_PROXY = "http://proxy.invalid:8080";
    process.env.http_proxy = "http://proxy.invalid:8080";
    const dir = mkdtempSync(join(tmpdir(), "rw-sbx-"));
    writeFileSync(
      join(dir, "dump.js"),
      "export function dump() { return { proxy: process.env.HTTP_PROXY ?? null, mode: process.env.EXTERNAL_MODE ?? null }; }\n",
    );
    const workRoot = mkdtempSync(join(tmpdir(), "rw-sbx-w-"));
    const { steps } = await runComputeSide(
      dir,
      [{ id: "c", group: "g", routeIds: ["fn:dump"], kind: "compute", target: "dump.js#dump", args: [], kwargs: {} }],
      { workRoot, side: "base", seedDb: join(workRoot, "nodb"), stepTimeoutMs: 15000, runtime: "node" },
    );
    expect(steps[0]?.status).toBe(200);
    expect(steps[0]?.body).toEqual({ proxy: null, mode: "mock" });
  });
});
