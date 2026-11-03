import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { synthesizeFromOpenApi, synthesizeTemplates, unverifiedQueue } from "./forge.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC = JSON.parse(readFileSync(join(ROOT, "demo", "shop-api-py", "openapi.json"), "utf8")) as unknown;

describe("OpenAPI synthesis (F-19, recorded doc)", () => {
  it("synthesizes one candidate per operation with filled params", () => {
    const cands = synthesizeFromOpenApi(DOC);
    expect(cands.length).toBe(11);
    const byId = new Map(cands.map((c) => [c.id, c]));
    expect(byId.get("forge-get-products-sku")?.path).toBe("/products/1");
    expect(byId.get("forge-post-predict")?.body).toEqual({ features: [] });
    expect(byId.get("forge-post-cart")?.body).toMatchObject({ items: [] });
    expect(byId.get("forge-post-cart")?.headers).toMatchObject({ "content-type": "application/json" });
    expect(byId.get("forge-get-health")?.body).toBeNull();
    expect(cands.every((c) => c.group === "forged" && c.source.startsWith("openapi:"))).toBe(true);
  });

  it("invalid documents synthesize nothing (never throws)", () => {
    expect(synthesizeFromOpenApi({})).toEqual([]);
    expect(synthesizeFromOpenApi(null)).toEqual([]);
    expect(synthesizeFromOpenApi({ paths: { "/x": { trace: {} } } })).toEqual([]);
  });
});

describe("auto-loop queue + templates (CT-F15-01)", () => {
  const node = (routeId: string, status: string, staticImpacted: boolean) =>
    ({ routeId, status, exercised: false, observedChanged: false, staticImpacted, inDiff: false, surprise: false, contradictedBy: [] }) as never;

  it("queues UNVERIFIED static-impacted http routes only", () => {
    expect(
      unverifiedQueue([
        node("route:GET /a", "UNVERIFIED", true),
        node("route:GET /b", "CLEARED", true),
        node("route:GET /c", "UNVERIFIED", false),
        node("fn:calc", "UNVERIFIED", true),
      ]),
    ).toEqual(["route:GET /a"]);
  });

  it("templates plain paths, skips parameterized ones", () => {
    const { candidates, skipped } = synthesizeTemplates(["route:GET /a", "route:POST /b", "route:GET /c/:id"]);
    expect(candidates.map((c) => [c.method, c.path, c.body])).toEqual([
      ["GET", "/a", null],
      ["POST", "/b", {}],
    ]);
    expect(candidates[1]?.headers).toEqual({ "content-type": "application/json" });
    expect(skipped).toEqual([{ routeId: "route:GET /c/:id", reason: "parameterized path needs human-supplied values" }]);
  });
});
