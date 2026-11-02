import { describe, expect, it } from "vitest";
import { verifyAll, verifyClaim } from "./verifiers.js";
import type { VerifyClaim, VerifyEvidence } from "./verifiers.js";

const CO = "route:POST /checkout";
const ORD = "route:GET /orders";
const ORD1 = "route:GET /orders/:id";
const REP = "route:GET /reports/sales";
const PROD = "route:GET /products";

function ev(over: Partial<{ observed: string[]; exercised: string[]; symbols: string[] }> = {}): VerifyEvidence {
  return {
    observedChanged: new Set(over.observed ?? []),
    exercised: new Set(over.exercised ?? [CO, ORD, ORD1, REP, PROD]),
    headSymbols: new Set(over.symbols ?? ["vipDiscount", "checkout", CO]),
    fieldDiffs: new Map(),
  };
}
function claim(over: Partial<VerifyClaim> & { type: VerifyClaim["type"] }): VerifyClaim {
  return { id: "t", text: "t", routes: [], ...over };
}

// Table: [name, claim, evidence, expected]
const SCOPE_CASES: [string, VerifyClaim, VerifyEvidence, string][] = [
  ["exclusive hit", claim({ id: "1", type: "SCOPE", text: "Only touches checkout.", routes: [CO] }), ev({ observed: [CO] }), "SUPPORTED"],
  ["exclusive miss outside", claim({ id: "2", type: "SCOPE", text: "Only touches checkout.", routes: [CO] }), ev({ observed: [CO, REP] }), "CONTRADICTED"],
  ["exclusive nothing changed", claim({ id: "3", type: "SCOPE", text: "Only touches checkout.", routes: [CO] }), ev({ observed: [] }), "CONTRADICTED"],
  ["inclusive all changed", claim({ id: "4", type: "SCOPE", text: "Checkout and orders changed.", routes: [CO, ORD] }), ev({ observed: [CO, ORD, REP] }), "SUPPORTED"],
  ["inclusive one static", claim({ id: "5", type: "SCOPE", text: "Checkout totals changed.", routes: [CO] }), ev({ observed: [REP] }), "CONTRADICTED"],
  ["family groups params", claim({ id: "6", type: "SCOPE", text: "Orders changed.", routes: [ORD] }), ev({ observed: [ORD1] }), "SUPPORTED"],
  ["empty routes", claim({ id: "7", type: "SCOPE", text: "Things changed.", routes: [] }), ev(), "UNVERIFIABLE"],
  ["unexercised declared", claim({ id: "8", type: "SCOPE", text: "X changed.", routes: ["route:GET /nope"] }), ev(), "UNVERIFIABLE"],
  ["dup routes deduped", claim({ id: "9", type: "SCOPE", text: "Checkout changed.", routes: [CO, CO] }), ev({ observed: [CO] }), "SUPPORTED"],
];

describe("verifiers (D-03)", () => {
  it.each(SCOPE_CASES)("SCOPE %s", (_n, c, e, expected) => {
    expect(verifyClaim(c, e).verdict).toBe(expected);
  });

  it("BEHAVIOR_UNCHANGED tri-state", () => {
    expect(verifyClaim(claim({ id: "a", type: "BEHAVIOR_UNCHANGED", routes: [PROD] }), ev()).verdict).toBe("SUPPORTED");
    expect(
      verifyClaim(claim({ id: "b", type: "BEHAVIOR_UNCHANGED", routes: [REP] }), ev({ observed: [REP] })).verdict,
    ).toBe("CONTRADICTED");
    expect(
      verifyClaim(claim({ id: "c", type: "BEHAVIOR_UNCHANGED", routes: ["route:GET /nope"] }), ev()).verdict,
    ).toBe("UNVERIFIABLE");
    expect(verifyClaim(claim({ id: "d", type: "BEHAVIOR_UNCHANGED", routes: [] }), ev()).verdict).toBe("UNVERIFIABLE");
  });

  it("IMPLEMENTED symbol and route rules", () => {
    expect(
      verifyClaim(claim({ id: "a", type: "IMPLEMENTED", text: "Added vipDiscount.", symbol: "vipDiscount" }), ev({ observed: [CO] })).verdict,
    ).toBe("SUPPORTED");
    expect(
      verifyClaim(claim({ id: "b", type: "IMPLEMENTED", text: "Added x.", symbol: "nope" }), ev()).verdict,
    ).toBe("CONTRADICTED");
    expect(
      verifyClaim(
        claim({ id: "c", type: "IMPLEMENTED", text: "Added route.", route: CO }),
        { ...ev({ observed: [CO] }), headSymbols: new Set([CO]) },
      ).verdict,
    ).toBe("SUPPORTED");
    // Symbol exists but nothing changed anywhere: no behavioral evidence.
    expect(
      verifyClaim(claim({ id: "d", type: "IMPLEMENTED", text: "Added vipDiscount.", symbol: "vipDiscount" }), ev({ observed: [] })).verdict,
    ).toBe("UNVERIFIABLE");
    // Adversarial: empty target.
    expect(verifyClaim(claim({ id: "e", type: "IMPLEMENTED", text: "Added stuff." }), ev()).verdict).toBe("UNVERIFIABLE");
  });

  it("API_COMPAT breaking detection", () => {
    const breaking: VerifyEvidence = {
      ...ev({ observed: [PROD] }),
      fieldDiffs: new Map([[PROD, [{ path: "$.products", before: [1, 2, 3], after: [1, 2] }]]]),
    };
    expect(
      verifyClaim(claim({ id: "a", type: "API_COMPAT", text: "No breaking API changes.", breaking: false }), breaking).verdict,
    ).toBe("CONTRADICTED");
    expect(
      verifyClaim(claim({ id: "b", type: "API_COMPAT", text: "No breaking API changes.", breaking: false }), ev()).verdict,
    ).toBe("SUPPORTED");
    const removed: VerifyEvidence = {
      ...ev(),
      fieldDiffs: new Map([[PROD, [{ path: "$.items", before: [1], after: undefined }]]]),
    };
    expect(
      verifyClaim(claim({ id: "c", type: "API_COMPAT", text: "No breaking API changes.", breaking: false }), removed).verdict,
    ).toBe("CONTRADICTED");
    const statusFlip: VerifyEvidence = {
      ...ev(),
      fieldDiffs: new Map([[REP, [{ path: "$.status", before: 401, after: 200 }]]]),
    };
    expect(
      verifyClaim(claim({ id: "d", type: "API_COMPAT", text: "No breaking API changes.", breaking: false }), statusFlip).verdict,
    ).toBe("CONTRADICTED");
  });

  it("TESTS is UNVERIFIABLE without CI (documented)", () => {
    expect(verifyClaim(claim({ id: "a", type: "TESTS", text: "Added 3 tests." }), ev()).verdict).toBe("UNVERIFIABLE");
  });

  it("verifyAll preserves order", () => {
    const out = verifyAll(
      [
        claim({ id: "a", type: "SCOPE", text: "Only touches checkout.", routes: [CO] }),
        claim({ id: "b", type: "SCOPE", text: "Only touches checkout.", routes: [REP] }),
      ],
      ev({ observed: [CO] }),
    );
    expect(out.map((r) => r.verdict)).toEqual(["SUPPORTED", "CONTRADICTED"]);
  });
});
