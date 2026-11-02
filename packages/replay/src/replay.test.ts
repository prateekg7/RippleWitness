import { describe, expect, it } from "vitest";
import { normalizeBody } from "./normalize.js";
import { aggregateByRoute, diffSteps, resolveStepRoutes } from "./diff.js";
import { detectVolatile } from "./flake.js";
import type { StepObservation } from "./types.js";

function step(over: Partial<StepObservation> = {}): StepObservation {
  return {
    scenarioId: "s1",
    stepIndex: 0,
    method: "GET",
    path: "/x",
    status: 200,
    body: { a: 1 },
    headers: { "content-type": "application/json" },
    ...over,
  };
}

describe("normalizer", () => {
  it("masks configured keys at any depth", () => {
    const out = normalizeBody({ id: 1, createdAt: "t", nested: { createdAt: "t2", keep: 1 } }, ["$..createdAt"]) as Record<
      string,
      unknown
    >;
    expect(out.createdAt).toBe("<volatile>");
    expect((out.nested as Record<string, unknown>).createdAt).toBe("<volatile>");
    expect((out.nested as Record<string, unknown>).keep).toBe(1);
  });
  it("leaves bodies alone with no mask", () => {
    expect(normalizeBody({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe("differ", () => {
  it("identical steps are unchanged", () => {
    const d = diffSteps(step(), step());
    expect(d.changed).toBe(false);
    expect(d.kinds).toEqual([]);
  });
  it("status change is kind=status with evidence", () => {
    const d = diffSteps(step({ status: 401 }), step({ status: 200 }));
    expect(d.changed).toBe(true);
    expect(d.kinds).toContain("status");
    expect(d.diffs[0]).toMatchObject({ kind: "status", before: 401, after: 200 });
  });
  it("body diff reports field paths", () => {
    const d = diffSteps(step({ body: { total: 1000 } }), step({ body: { total: 900 } }));
    expect(d.changed).toBe(true);
    expect(d.kinds).toEqual(["body"]);
    expect(d.diffs).toContainEqual({ kind: "body", path: "$.total", before: 1000, after: 900 });
  });
  it("unordered routes ignore array order", () => {
    const opts = { unorderedRoutes: ["route:GET /x"], stepRoute: () => "route:GET /x" };
    const d = diffSteps(step({ body: [1, 2] }), step({ body: [2, 1] }), opts);
    expect(d.changed).toBe(false);
    const d2 = diffSteps(step({ body: [1, 2] }), step({ body: [2, 1] }));
    expect(d2.changed).toBe(true);
  });
  it("aggregates step diffs per route", () => {
    const agg = aggregateByRoute(
      [
        { scenarioId: "s1", stepIndex: 0, method: "GET", path: "/x", changed: true, kinds: ["body"], diffs: [] },
        { scenarioId: "s2", stepIndex: 0, method: "GET", path: "/x", changed: false, kinds: [], diffs: [] },
      ],
      new Map([["s1", ["route:A"]], ["s2", ["route:A", "route:B"]]]),
    );
    const a = agg.find((r) => r.routeId === "route:A");
    const b = agg.find((r) => r.routeId === "route:B");
    expect(a?.changed).toBe(true);
    expect(b?.changed).toBe(false);
    expect(b?.scenarioIds).toEqual(["s2"]);
  });
  it("attributes a changed step to its own route, not the whole scenario", () => {
    const declared = ["route:POST /cart", "route:POST /checkout"];
    const agg = aggregateByRoute(
      [
        { scenarioId: "s1", stepIndex: 0, method: "POST", path: "/cart", changed: false, kinds: [], diffs: [] },
        { scenarioId: "s1", stepIndex: 1, method: "POST", path: "/checkout", changed: true, kinds: ["body"], diffs: [] },
      ],
      new Map([["s1", declared]]),
    );
    expect(agg.find((r) => r.routeId === "route:POST /checkout")?.changed).toBe(true);
    expect(agg.find((r) => r.routeId === "route:POST /cart")?.changed).toBe(false);
    expect(agg.find((r) => r.routeId === "route:POST /cart")?.scenarioIds).toEqual(["s1"]);
  });
  it("matches :param segments and strips query strings", () => {
    expect(resolveStepRoutes("GET", "/orders/id-42-9", ["route:GET /orders/:id", "route:GET /orders"])).toEqual([
      "route:GET /orders/:id",
    ]);
    expect(resolveStepRoutes("GET", "/shipping/quote?subtotal=5", ["route:GET /shipping/quote"])).toEqual([
      "route:GET /shipping/quote",
    ]);
    expect(resolveStepRoutes("DELETE", "/x", ["route:GET /x"])).toEqual(["route:GET /x"]);
  });
});

describe("flake guard", () => {
  it("identical base runs yield no volatile steps", () => {
    const r = detectVolatile([step()], [step()], new Map([["s1", ["route:A"]]]));
    expect(r.volatileSteps).toEqual([]);
    expect(r.volatileRoutes).toEqual([]);
  });
  it("a differing base step marks its routes volatile", () => {
    const r = detectVolatile(
      [step({ body: { t: "t1" } })],
      [step({ body: { t: "t2" } })],
      new Map([["s1", ["route:A"]]]),
    );
    expect(r.volatileSteps).toEqual(["s1:0"]);
    expect(r.volatileRoutes).toEqual(["route:A"]);
  });
  it("masked fields do not flake (IT-REP-04 unit half)", () => {
    const r = detectVolatile(
      [step({ body: { createdAt: "t1", v: 1 } })],
      [step({ body: { createdAt: "t2", v: 1 } })],
      new Map([["s1", ["route:A"]]]),
      { mask: ["$..createdAt"] },
    );
    expect(r.volatileSteps).toEqual([]);
  });
});
