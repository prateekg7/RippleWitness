import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runComputeSide } from "./runner.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHOPJS = join(ROOT, "demo", "shop-api-js", "src");

describe("node compute runtime F-10 (CT-FNR-02)", () => {
  function scenario(target: string, args: unknown[] = []) {
    return { id: "c1", group: "g", routeIds: [`fn:${target}`], kind: "compute" as const, target, args, kwargs: {} };
  }

  it("calls a JS export and observes the value", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "rw-nodec-"));
    const { steps } = await runComputeSide(
      SHOPJS,
      [scenario("lib/money.js#roundMoney", [102.5])],
      { workRoot, side: "base", seedDb: join(workRoot, "nodb"), stepTimeoutMs: 15000, runtime: "node" },
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe(200);
    expect(steps[0]?.body).toBe(103);
  });

  it("imports plain TS via type-stripping", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "rw-nodec-"));
    const { steps } = await runComputeSide(
      join(ROOT, "demo", "shop-api", "src"),
      [scenario("lib/money.ts#roundMoney", [102.5])],
      { workRoot, side: "base", seedDb: join(workRoot, "nodb"), stepTimeoutMs: 15000, runtime: "node" },
    );
    expect(steps[0]?.status).toBe(200);
    expect(steps[0]?.body).toBe(103);
  });

  it("reports failures inside the envelope, never throws", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "rw-nodec-"));
    const dir = mkdtempSync(join(tmpdir(), "rw-fn-"));
    writeFileSync(join(dir, "boom.js"), "export function f() { throw new Error('kablam'); }\n");
    const { steps } = await runComputeSide(
      dir,
      [scenario("boom.js#f"), scenario("missing.js#f"), scenario("nope")],
      { workRoot, side: "base", seedDb: join(workRoot, "nodb"), stepTimeoutMs: 15000, runtime: "node" },
    );
    expect(steps.map((s) => s.status)).toEqual([500, 500, 500]);
    expect(JSON.stringify(steps[0]?.body)).toContain("kablam");
  });

  it("rejects kwargs and worktree escapes", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "rw-nodec-"));
    const base = { id: "c", group: "g", routeIds: ["fn:x"], kind: "compute" as const, args: [] as unknown[] };
    const { steps } = await runComputeSide(
      SHOPJS,
      [
        { ...base, id: "k", target: "lib/money.js#roundMoney", kwargs: { cents: 1 } },
        { ...base, id: "e", target: "../money.js#roundMoney", kwargs: {} },
      ],
      { workRoot, side: "base", seedDb: join(workRoot, "nodb"), stepTimeoutMs: 15000, runtime: "node" },
    );
    expect(JSON.stringify(steps[0]?.body)).toContain("kwargs_unsupported");
    expect(JSON.stringify(steps[1]?.body)).toContain("escapes worktree");
  });
});
