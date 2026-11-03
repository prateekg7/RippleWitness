import { describe, expect, it } from "vitest";
import { fuseRoutes } from "./fuse.js";
import { scoreGate } from "./score.js";
import type { ClaimEvidence, RouteEvidence } from "./types.js";

function ev(over: Partial<RouteEvidence> & { routeId: string }): RouteEvidence {
  return { exercised: false, observedChanged: false, staticImpacted: false, inDiff: false, isNew: false, ...over };
}

describe("fusion (C-05)", () => {
  it("PR-00 gap: checkout CONFIRMED, reports SURPRISE, untouched QUIET", () => {
    const out = fuseRoutes(
      [
        ev({ routeId: "route:POST /checkout", exercised: true, observedChanged: true, staticImpacted: true, inDiff: true }),
        ev({ routeId: "route:GET /reports/sales", exercised: true, observedChanged: true, staticImpacted: false }),
        ev({ routeId: "route:GET /products", exercised: true, observedChanged: false, staticImpacted: false }),
      ],
      [],
    );
    const byId = Object.fromEntries(out.map((n) => [n.routeId, n.status]));
    expect(byId["route:POST /checkout"]).toBe("CONFIRMED");
    expect(byId["route:GET /reports/sales"]).toBe("SURPRISE");
    expect(byId["route:GET /products"]).toBe("QUIET");
  });

  it("CLEARED, UNVERIFIED, DIFF statuses", () => {
    const out = fuseRoutes(
      [
        ev({ routeId: "r1", exercised: true, observedChanged: false, staticImpacted: true }),
        ev({ routeId: "r2", exercised: false, staticImpacted: true }),
        ev({ routeId: "r3", isNew: true, exercised: true, observedChanged: true }),
      ],
      [],
    );
    expect(out.find((n) => n.routeId === "r1")?.status).toBe("CLEARED");
    expect(out.find((n) => n.routeId === "r2")?.status).toBe("UNVERIFIED");
    expect(out.find((n) => n.routeId === "r3")?.status).toBe("DIFF");
  });

  it("contradiction marks CONTRADICTED but SURPRISE wins on conflict", () => {
    const claims: ClaimEvidence[] = [
      { claimId: "c1", type: "BEHAVIOR_UNCHANGED", verdict: "CONTRADICTED", routes: ["r1", "r2"] },
    ];
    const out = fuseRoutes(
      [
        ev({ routeId: "r1", exercised: true, observedChanged: false, staticImpacted: true }),
        ev({ routeId: "r2", exercised: true, observedChanged: true, staticImpacted: false }),
      ],
      claims,
    );
    expect(out.find((n) => n.routeId === "r1")?.status).toBe("CONTRADICTED");
    expect(out.find((n) => n.routeId === "r2")?.status).toBe("SURPRISE");
    expect(out.find((n) => n.routeId === "r2")?.contradictedBy).toEqual(["c1"]);
  });

  it("output is sorted and deterministic", () => {
    const a = JSON.stringify(fuseRoutes([ev({ routeId: "b" }), ev({ routeId: "a" })], []));
    expect(a.indexOf('"routeId":"a"')).toBeLessThan(a.indexOf('"routeId":"b"'));
  });
});

describe("gate scoring (C-05)", () => {
  const cfg = { minRecall: 0.75, minPrecision: 0.5 };
  const evidence = [
    ev({ routeId: "route:A", exercised: true, observedChanged: true, staticImpacted: true, impactPath: ["x", "fn:m"] }),
    ev({ routeId: "route:B", exercised: true, observedChanged: true, staticImpacted: false }),
    ev({ routeId: "route:C", exercised: true, observedChanged: false, staticImpacted: true }),
  ];

  it("empty prediction against changes fails with misses", () => {
    const s = scoreGate({ routeIds: [], nothingElse: false }, evidence, cfg);
    expect(s.passed).toBe(false);
    expect(s.recall).toBe(0);
    expect(s.misses.map((m) => m.routeId)).toEqual(["route:A", "route:B"]);
  });

  it("nothing-else passes only when observed is empty", () => {
    const s = scoreGate({ routeIds: [], nothingElse: true }, evidence, cfg);
    expect(s.passed).toBe(false);
    expect(s.passReason).toBe("nothing_else_claimed_but_changes_observed");
    const s2 = scoreGate(
      { routeIds: [], nothingElse: true },
      [ev({ routeId: "route:C", exercised: true })],
      cfg,
    );
    expect(s2.passed).toBe(true);
  });

  it("duplicate predictions do not inflate the score", () => {
    const s = scoreGate({ routeIds: ["route:A", "route:A", "route:B"], nothingElse: false }, evidence, cfg);
    expect(s.predicted).toEqual(["route:A", "route:B"]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.passed).toBe(true);
  });

  it("false positives hurt precision", () => {
    const s = scoreGate({ routeIds: ["route:A", "route:X", "route:Y"], nothingElse: false }, evidence, cfg);
    expect(s.falsePositives).toEqual(["route:X", "route:Y"]);
    expect(s.precision).toBeCloseTo(1 / 3);
    expect(s.passed).toBe(false);
  });

  it("miss causes classify from impact paths", () => {
    const s = scoreGate({ routeIds: [], nothingElse: false }, evidence, cfg);
    const byId = Object.fromEntries(s.misses.map((m) => [m.routeId, m.cause]));
    expect(byId["route:A"]).toBe("missed_shared_helper");
    expect(byId["route:B"]).toBe("implicit_contract");
  });

  it("db/config sharing paths classify", () => {
    const s = scoreGate(
      { routeIds: [], nothingElse: false },
      [
        ev({ routeId: "r1", exercised: true, observedChanged: true, impactPath: ["h", "shared:db:orders"] }),
        ev({ routeId: "r2", exercised: true, observedChanged: true, impactPath: ["h", "shared:config:shippingFlatCents"] }),
      ],
      cfg,
    );
    expect(s.misses.find((m) => m.routeId === "r1")?.cause).toBe("missed_db_coupling");
    expect(s.misses.find((m) => m.routeId === "r2")?.cause).toBe("missed_config_coupling");
  });

  it("rejects invalid predictions", () => {
    expect(() => scoreGate({ routeIds: [""], nothingElse: false }, [], cfg)).toThrow();
    expect(() => scoreGate(null, [], cfg)).toThrow();
  });
});

describe("fusion dynamic-only (J-05)", () => {
  it("reports observed outcomes without static claims; no SURPRISE without a static pass", () => {
    const out = fuseRoutes(
      [
        ev({ routeId: "route:POST /x", exercised: true, observedChanged: true }),
        ev({ routeId: "route:GET /y", exercised: true, observedChanged: false }),
        ev({ routeId: "route:GET /z", exercised: false }),
      ],
      [],
      { staticUnknown: true },
    );
    const byId = Object.fromEntries(out.map((n) => [n.routeId, n.status]));
    expect(byId).toEqual({
      "route:POST /x": "CHANGED",
      "route:GET /y": "UNCHANGED",
      "route:GET /z": "UNCOVERED",
    });
    expect(out.every((n) => n.surprise === false)).toBe(true);
  });
  it("contradicted claims still surface in dynamic-only mode", () => {
    const claims: ClaimEvidence[] = [{ claimId: "c1", type: "SCOPE", verdict: "CONTRADICTED", routes: ["route:POST /x"] }];
    const out = fuseRoutes([ev({ routeId: "route:POST /x", exercised: true, observedChanged: false })], claims, {
      staticUnknown: true,
    });
    expect(out[0]?.status).toBe("CONTRADICTED");
  });
});
