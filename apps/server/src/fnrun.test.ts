import { describe, expect, it } from "vitest";
import { validateFnTarget } from "./fnrun.js";

describe("fn target validation (CT-FNR-03)", () => {
  it("accepts well-formed python and node targets", () => {
    expect(validateFnTarget("model:predict", "python")).toEqual({ ok: true });
    expect(validateFnTarget("pkg.mod:fn_name", "python")).toEqual({ ok: true });
    expect(validateFnTarget("lib/money.js#roundMoney", "node")).toEqual({ ok: true });
    expect(validateFnTarget("src/lib/money.ts#roundMoney", "node")).toEqual({ ok: true });
  });

  it("rejects malformed and escaping targets", () => {
    expect(validateFnTarget("model-predict", "python").ok).toBe(false);
    expect(validateFnTarget("os:system;rm", "python").ok).toBe(false);
    expect(validateFnTarget("lib/money.js", "node").ok).toBe(false);
    expect(validateFnTarget("../x.js#f", "node")).toEqual({ ok: false, error: "path escapes app dir" });
    expect(validateFnTarget("x.exe#f", "node").ok).toBe(false);
  });
});
