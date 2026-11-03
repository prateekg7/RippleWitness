import { describe, expect, it } from "vitest";
import { normalizeBody } from "./normalize.js";
import { aggregateByRoute, diffSteps, numbersClose, resolveStepRoutes } from "./diff.js";
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
        { scenarioId: "s1", stepIndex: 0, method: "GET", path: "/x", changed: true, kinds: ["body"], diffs: [], tolerated: [] },
        { scenarioId: "s2", stepIndex: 0, method: "GET", path: "/x", changed: false, kinds: [], diffs: [], tolerated: [] },
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
        { scenarioId: "s1", stepIndex: 0, method: "POST", path: "/cart", changed: false, kinds: [], diffs: [], tolerated: [] },
        { scenarioId: "s1", stepIndex: 1, method: "POST", path: "/checkout", changed: true, kinds: ["body"], diffs: [], tolerated: [] },
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
  it("a missing twin step excludes its routes too", () => {
    const r = detectVolatile([step()], [], new Map([["s1", ["route:A"]]]));
    expect(r.volatileSteps).toEqual(["s1:0"]);
    expect(r.volatileRoutes).toEqual(["route:A"]);
  });
});

describe("step route attribution", () => {
  it("literal segments match exactly (regex metacharacters escaped)", () => {
    const declared = ["route:GET /v1.2/ping", "route:GET /v1x2/ping"];
    expect(resolveStepRoutes("GET", "/v1.2/ping", declared)).toEqual(["route:GET /v1.2/ping"]);
    expect(resolveStepRoutes("GET", "/v1x2/ping", declared)).toEqual(["route:GET /v1x2/ping"]);
    expect(resolveStepRoutes("GET", "/items/42", ["route:GET /items/:id"])).toEqual(["route:GET /items/:id"]);
    expect(resolveStepRoutes("GET", "/items/42/x", ["route:GET /items/:id"])).toEqual(["route:GET /items/:id"]);
  });
});

describe("process registry teardown", () => {
  it("captures the stderr tail of failed children", async () => {
    const { ProcRegistry } = await import("./proc.js");
    const procs = new ProcRegistry();
    const child = procs.spawn("node", ["-e", "console.error('boot kaboom'); process.exit(3)"], process.cwd(), {
      PATH: process.env.PATH as string,
    }, { captureStderr: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBe(3);
    expect(procs.stderrTail(child)).toContain("boot kaboom");
    const quiet = procs.spawn("node", ["-e", "process.exit(0)"], process.cwd(), { PATH: process.env.PATH as string });
    await new Promise((r) => setTimeout(r, 500));
    expect(procs.stderrTail(quiet)).toBe("");
    await procs.killAll();
  });

  it("escalates to SIGKILL for children that trap SIGTERM", async () => {
    const { ProcRegistry } = await import("./proc.js");
    const procs = new ProcRegistry();
    const child = procs.spawn("node", ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], process.cwd(), {
      PATH: process.env.PATH as string,
    });
    expect(child.pid).toBeDefined();
    await procs.killAll();
    expect(procs.size).toBe(0);
    expect(() => process.kill(child.pid as number, 0)).toThrow();
  });
});

describe("tolerance differ (F-21)", () => {
  const TOL = [{ path: "$.score" }, { path: "$.vec" }];

  it("CT-NUM-01: deviation exactly at the boundary counts as within tolerance", () => {
    // |1.0 - 1.125| = 0.125 exactly (powers of two) <= atol(0.125) + rtol(0)*|b|
    expect(numbersClose(1.0, 1.125, { atol: 0.125, rtol: 0 }).close).toBe(true);
    expect(numbersClose(1.0, 1.125, { atol: 0.125, rtol: 0 }).deviation).toBe(0.125);
    expect(numbersClose(1.0, 1.1250001, { atol: 0.125, rtol: 0 }).close).toBe(false);
    const d = diffSteps(step({ body: { score: 1.0 } }), step({ body: { score: 1.0 + 1e-9 } }), { tolerances: TOL });
    expect(d.changed).toBe(false);
    expect(d.tolerated).toHaveLength(1);
    expect(d.tolerated[0]).toMatchObject({ path: "$.score", before: 1.0, after: 1.0 + 1e-9 });
  });

  it("above-tolerance numerics still change, with deviation recorded", () => {
    const d = diffSteps(step({ body: { score: 1.0 } }), step({ body: { score: 2.0 } }), { tolerances: TOL });
    expect(d.changed).toBe(true);
    expect(d.diffs.map((x) => x.path)).toContain("$.score");
    expect(d.tolerated).toHaveLength(0);
  });

  it("CT-NUM-02: tensor shape change is a real diff even with equal values", () => {
    const d = diffSteps(step({ body: { vec: [1, 2] } }), step({ body: { vec: [1, 2, 3] } }), { tolerances: TOL });
    expect(d.changed).toBe(true);
    const same = diffSteps(step({ body: { vec: [1.0, 2.0] } }), step({ body: { vec: [1.0, 2.0 + 1e-9] } }), { tolerances: TOL });
    expect(same.changed).toBe(false);
    expect(same.tolerated.map((t) => t.path)).toEqual(["$.vec[1]"]);
  });

  it("CT-NUM-03: NaN equality requires explicit nanEqual", () => {
    expect(numbersClose(Number.NaN, Number.NaN, {}).close).toBe(false);
    expect(numbersClose(Number.NaN, Number.NaN, { nanEqual: true }).close).toBe(true);
  });

  it("CT-NUM-04: non-numeric leaves under a tolerance path stay byte-equal", () => {
    const d = diffSteps(step({ body: { score: "high" } }), step({ body: { score: "low" } }), { tolerances: TOL });
    expect(d.changed).toBe(true);
    const typeChange = diffSteps(step({ body: { score: 1 } }), step({ body: { score: "1" } }), { tolerances: TOL });
    expect(typeChange.changed).toBe(true);
  });

  it("unconfigured paths are unaffected by tolerance specs", () => {
    const d = diffSteps(step({ body: { other: 1.0 } }), step({ body: { other: 1.0 + 1e-9 } }), { tolerances: TOL });
    expect(d.changed).toBe(true);
  });
});

describe("auto-mask learning (F-22)", () => {
  it("learns $..key masks for wobbling body leaves only", async () => {
    const { learnMasks } = await import("./flake.js");
    expect(
      learnMasks(
        [step({ body: { createdAt: "t1", v: 1 } })],
        [step({ body: { createdAt: "t2", v: 1 } })],
      ),
    ).toEqual(["$..createdAt"]);
    expect(learnMasks([step({ body: { v: 1 } })], [step({ body: { v: 1 } })])).toEqual([]);
  });
  it("status and header flaps are not maskable", async () => {
    const { learnMasks } = await import("./flake.js");
    expect(
      learnMasks(
        [step({ status: 200, headers: { "content-type": "a" } })],
        [step({ status: 500, headers: { "content-type": "b" } })],
      ),
    ).toEqual([]);
  });
  it("array element paths reduce to the array key", async () => {
    const { learnMasks } = await import("./flake.js");
    expect(
      learnMasks([step({ body: { v: [1] } })], [step({ body: { v: [2] } })]),
    ).toEqual(["$..v"]);
  });
});
