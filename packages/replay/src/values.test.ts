import { describe, expect, it } from "vitest";
import { valuesMatch } from "./values.js";

describe("valuesMatch F-10 (CT-FNR-01)", () => {
  it("matches identical scalars and structures", () => {
    expect(valuesMatch(1, 1)).toBe(true);
    expect(valuesMatch("a", "a")).toBe(true);
    expect(valuesMatch(null, null)).toBe(true);
    expect(valuesMatch({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
  });

  it("rejects type and shape mismatches", () => {
    expect(valuesMatch(1, "1")).toBe(false);
    expect(valuesMatch([1, 2], [1])).toBe(false);
    expect(valuesMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valuesMatch({ a: 1 }, {})).toBe(false);
  });

  it("compares floats exactly by default, tolerantly under a spec", () => {
    expect(valuesMatch(1.0, 1.1)).toBe(false);
    expect(valuesMatch(0.1 + 0.2, 0.3)).toBe(true); // within default atol
    expect(valuesMatch({ v: 1.0 }, { v: 1.05 }, [{ path: "$.v", rtol: 0.1, atol: 0 }])).toBe(true);
    expect(valuesMatch({ v: 1.0 }, { v: 1.5 }, [{ path: "$.v", rtol: 0.1, atol: 0 }])).toBe(false);
  });

  it("applies specs to nested paths, including array indices", () => {
    expect(valuesMatch({ s: [1.0, 2.0] }, { s: [1.0, 2.2] }, [{ path: "$.s", rtol: 0.2, atol: 0 }])).toBe(true);
    expect(valuesMatch(Number.NaN, Number.NaN)).toBe(false);
    expect(valuesMatch(Number.NaN, Number.NaN, [{ path: "$", nanEqual: true }])).toBe(true);
  });
});
