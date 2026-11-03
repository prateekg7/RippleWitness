import { describe, expect, it } from "vitest";
import type { HarvestResult } from "./harvest.js";
import { diffHarvest, harvestToScenarios } from "./harvest.js";

const asResult = (tests: [string, "passed" | "failed" | "skipped"][], calls: { test: string; method: string; url: string }[] = []): HarvestResult => ({
  tests: tests.map(([id, outcome]) => ({ id, outcome })),
  calls: calls.map((c) => ({ ...c, headers: {}, body: null, truncated: false })),
});

describe("harvest merge (F-24, recorded)", () => {
  it("CT-HRV-01: outcome flips and added/removed tests are first-class", () => {
    const { flips } = diffHarvest(
      asResult([["t.py::a", "passed"], ["t.py::b", "passed"], ["t.py::gone", "passed"]]),
      asResult([["t.py::a", "failed"], ["t.py::b", "passed"], ["t.py::new", "passed"]]),
    );
    expect(flips).toEqual([
      { id: "t.py::a", base: "passed", head: "failed" },
      { id: "t.py::gone", base: "passed", head: "absent" },
      { id: "t.py::new", base: "absent", head: "passed" },
    ]);
  });

  it("only calls from passing-on-both, untruncated tests become candidates", () => {
    const { passingBoth } = diffHarvest(
      asResult([["t.py::a", "passed"], ["t.py::b", "passed"]]),
      asResult(
        [["t.py::a", "passed"], ["t.py::b", "failed"]],
        [
          { test: "t.py::a", method: "GET", url: "http://x:1/items?sku=1" },
          { test: "t.py::b", method: "GET", url: "http://x:1/other" },
        ],
      ),
    );
    expect(passingBoth.map((c) => c.test)).toEqual(["t.py::a"]);
    const [cand] = harvestToScenarios(passingBoth);
    expect(cand).toMatchObject({ method: "GET", path: "/items?sku=1", group: "harvested", sourceTest: "t.py::a" });
    expect(cand?.id).toMatch(/^harvest-\d+$/);
  });

  it("CT-HRV-02: truncated captures never become candidates", () => {
    const head: HarvestResult = {
      tests: [{ id: "t.py::a", outcome: "passed" }],
      calls: [{ test: "t.py::a", method: "POST", url: "http://x/big", headers: {}, body: "…", truncated: true }],
    };
    const base: HarvestResult = { tests: [{ id: "t.py::a", outcome: "passed" }], calls: [] };
    expect(diffHarvest(base, head).passingBoth).toEqual([]);
  });
});
