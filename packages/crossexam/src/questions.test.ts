import { describe, expect, it } from "vitest";
import type { FusedNode } from "@ripplewitness/core";
import { assessAnswer, quotaAllows } from "./qa.js";
import { buildQuestions, pickNext, rephrasePassthrough, validatePhrased } from "./questions.js";

function node(routeId: string, status: FusedNode["status"]): FusedNode {
  return { routeId, status, exercised: true, observedChanged: status === "SURPRISE", staticImpacted: true, inDiff: false, surprise: status === "SURPRISE", contradictedBy: [] };
}

describe("questions (D-04)", () => {
  it("CT-Q-01: SURPRISE + CONTRADICTION + CREEP templates with anchors", () => {
    const qs = buildQuestions({
      fused: [node("route:A", "SURPRISE"), node("route:B", "UNVERIFIED"), node("route:C", "QUIET")],
      claimResults: [{ claimId: "c1", verdict: "CONTRADICTED", routes: ["route:A"] }],
    });
    expect(qs.map((q) => q.template)).toEqual(["SURPRISE_RIPPLE", "CONTRADICTION", "SCOPE_CREEP"]);
    expect(qs[0]?.anchors.length).toBeGreaterThan(0);
    expect(qs[0]?.text).toContain("[[route:A]]");
  });
  it("CT-Q-02: misses become questions, capped at 5 by need", () => {
    const qs = buildQuestions({
      fused: ["a", "b", "c", "d", "e", "f"].map((r) => node(`route:${r}`, "SURPRISE")),
      claimResults: [],
      misses: [{ routeId: "route:m", cause: "implicit_contract" }],
    });
    expect(qs).toHaveLength(5);
    expect(qs.every((q) => q.template === "SURPRISE_RIPPLE")).toBe(true);
  });
  it("CT-Q-03: phraser validator keeps protected tokens", () => {
    const raw = "Why did [[route:A]] change with [[cause-1]]?";
    expect(validatePhrased(raw, "Why did route:A change with cause-1, exactly?")).toBe(true);
    expect(validatePhrased(raw, "Why did it change?")).toBe(false);
    expect(rephrasePassthrough(raw)).toBe("Why did route:A change with cause-1?");
  });
  it("pickNext skips non-OPEN by need", () => {
    expect(pickNext([{ need: 1, status: "ASKED" }, { need: 3, status: "OPEN" }, { need: 2, status: "OPEN" }])).toBe(1);
    expect(pickNext([{ need: 3, status: "ASKED" }])).toBe(-1);
  });
});

describe("Q&A resolution (D-05)", () => {
  it("CT-QA-01: supported + explained resolves", () => {
    expect(assessAnswer(["SUPPORTED", "SUPPORTED"], true, 1, "a").status).toBe("RESOLVED");
  });
  it("CT-QA-02: contradicted contests", () => {
    expect(assessAnswer(["SUPPORTED", "CONTRADICTED"], true, 1, "a").status).toBe("CONTESTED");
  });
  it("CT-QA-03: empty verdicts follow up until cap, then ASKED", () => {
    const r1 = assessAnswer([], false, 1, "anchor");
    expect(r1.status).toBe("OPEN");
    expect(r1.followup).toContain("anchor");
    expect(assessAnswer([], false, 3, "anchor").status).toBe("ASKED");
  });
  it("quota allows at most 5 asked", () => {
    expect(quotaAllows(4)).toBe(true);
    expect(quotaAllows(5)).toBe(false);
  });
});
