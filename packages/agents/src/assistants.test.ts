import { describe, expect, it } from "vitest";
import { parseDiffHunks, validateFindings } from "./reviewer.js";
import type { AiFinding } from "./reviewer.js";
import { validateExplanation } from "./explainer.js";
import { validateSummary } from "./summary.js";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -40,6 +40,9 @@
 context
+added one
+added two
 context
@@ -100,3 +103,4 @@
 context
+added three
`;

function finding(over: Partial<AiFinding> = {}): AiFinding {
  return { file: "src/app.ts", startLine: 41, endLine: 42, severity: "high", category: "bug", note: "x", ...over };
}

describe("assistants (F-01..F-03)", () => {
  it("CT-RV-01: hunk parsing finds new-tree ranges", () => {
    expect(parseDiffHunks(DIFF)).toEqual([
      { file: "src/app.ts", newStart: 40, newEnd: 48 },
      { file: "src/app.ts", newStart: 103, newEnd: 106 },
    ]);
  });
  it("CT-RV-02: findings outside the diff are rejected", () => {
    const { valid, rejected } = validateFindings(
      [finding(), finding({ startLine: 1, endLine: 2 }), finding({ startLine: 104, endLine: 104 }), finding({ file: "nope.ts", startLine: 40, endLine: 41 })],
      parseDiffHunks(DIFF),
    );
    expect(valid).toHaveLength(2);
    expect(rejected.map((r) => r.reason)).toEqual(["range not in diff", "range not in diff"]);
  });
  it("CT-RV-03: inverted ranges and the 15-cap are rejected", () => {
    const many = Array.from({ length: 16 }, (_, i) => finding({ startLine: 41, endLine: 41, note: `n${i}` }));
    const { valid, rejected } = validateFindings([finding({ startLine: 5, endLine: 2 }), ...many], parseDiffHunks(DIFF));
    expect(valid).toHaveLength(14);
    expect(rejected.some((r) => r.reason === "inverted range")).toBe(true);
    expect(rejected.some((r) => r.reason === "over 15-findings cap")).toBe(true);
  });
  it("CT-EX-01: explainer routes must come from evidence", () => {
    const input = { routeId: "route:A", hunk: "h", neighbors: [], observations: [], knownRoutes: ["route:A"] };
    expect(validateExplanation({ summary: "One sentence.", what_changed: [], who_is_affected: ["route:A"], risks: [], confidence: "high" }, input)).toEqual({ ok: true });
    expect(validateExplanation({ summary: "One.", what_changed: [], who_is_affected: ["route:ZZZ"], risks: [], confidence: "low" }, input).ok).toBe(false);
    expect(
      validateExplanation({ summary: "One. Two. Three. Four. Five. Six.", what_changed: [], who_is_affected: [], risks: [], confidence: "low" }, input).ok,
    ).toBe(false);
  });
  it("CT-SU-01: summary must list every unverified route", () => {
    const input = { diff: "d", observations: [], exercised: ["route:A"], unexercisedImpacted: ["route:B"] };
    expect(validateSummary({ title: "t", body: "b", observed_impact: ["route:A"], unverified: ["route:B"] }, input)).toEqual({ ok: true });
    expect(validateSummary({ title: "t", body: "b", observed_impact: ["route:A"], unverified: [] }, input).ok).toBe(false);
    expect(validateSummary({ title: "t", body: "b", observed_impact: ["route:ZZZ"], unverified: ["route:B"] }, input).ok).toBe(false);
  });
});
