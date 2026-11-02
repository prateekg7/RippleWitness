import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { proposeCanary, proposeWith } from "./operators.js";

const SHOP_APP = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "demo", "shop-api", "src", "app.ts"),
  "utf8",
);

function parses(source: string): boolean {
  try {
    const p = new Project({ useInMemoryFileSystem: true });
    p.createSourceFile("t.ts", source);
    return true;
  } catch {
    return false;
  }
}

describe("canary operators (E-04)", () => {
  it("CT-CN-01: every operator produces parseable output on shop-api", () => {
    for (const op of ["flip_cmp", "negate_cond", "drop_guard", "off_by_one", "swap_args", "const_step"] as const) {
      const c = proposeWith(SHOP_APP, "src/app.ts", op);
      expect(c, op).not.toBeNull();
      expect(parses(c?.patched ?? "")).toBe(true);
      expect(c?.line).toBeGreaterThan(0);
    }
  });
  it("CT-CN-02: default proposal prefers flip_cmp", () => {
    const c = proposeCanary(SHOP_APP, "src/app.ts");
    expect(c?.operator).toBe("flip_cmp");
  });
  it("CT-CN-03: comment-only source yields nothing (AST, not text)", () => {
    expect(proposeCanary("// a >= b\n// if (x) return;\n", "x.ts")).toBeNull();
  });
});
