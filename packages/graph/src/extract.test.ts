import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractStaticGraph } from "./extract.js";
import { computeImpact } from "./impact.js";
import type { ChangedFile } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const SHOP = join(ROOT, "demo", "shop-api");
const MINI = join(HERE, "fixtures", "shop-mini");
const BAD = join(HERE, "fixtures", "shop-bad");

const EXPECTED_ROUTES = [
  "route:GET /health",
  "route:GET /products",
  "route:GET /products/:sku",
  "route:POST /cart",
  "route:GET /cart/:id",
  "route:POST /checkout",
  "route:GET /orders",
  "route:GET /orders/:id",
  "route:GET /shipping/quote",
  "route:GET /inventory/:sku",
  "route:GET /reports/sales",
  "route:POST /payments/charge",
];

/** Minimal unified-diff hunk parser: added line numbers per file (new tree). */
function parsePatchAddedLines(patch: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  let file = "";
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
      out.push({ file, lines: [] });
    } else if (line.startsWith("@@ ")) {
      const m = /\+(\d+)/.exec(line);
      newLine = m ? Number(m[1]) : 0;
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) {
      out[out.length - 1]?.lines.push(newLine);
      newLine += 1;
    } else if (file && !line.startsWith("-") && newLine > 0) {
      newLine += 1;
    }
  }
  return out.filter((f) => f.lines.length > 0);
}

describe("static graph extractor (C-01)", () => {
  it("IT-GR-01: discovers all shop-api routes with methods and params", () => {
    const g = extractStaticGraph(SHOP);
    const routes = g.nodes.filter((n) => n.kind === "route").map((n) => n.id);
    for (const r of EXPECTED_ROUTES) expect(routes).toContain(r);
  });

  it("IT-GR-01b: resolves router prefixes on the fixture", () => {
    const g = extractStaticGraph(MINI);
    const routes = g.nodes.filter((n) => n.kind === "route").map((n) => n.id);
    expect(routes).toContain("route:GET /api/items");
    expect(routes).toContain("route:GET /health");
  });

  it("IT-GR-02: call edges stop at depth 3", () => {
    const g = extractStaticGraph(MINI);
    const calls = g.edges.filter((e) => e.type === "calls").map((e) => `${e.from} -> ${e.to}`);
    expect(calls.some((c) => c.includes("service.ts:deeper"))).toBe(true);
    // deeper -> level4 must NOT be extracted (would be depth 4 from handler)
    expect(calls.some((c) => c.includes(":deeper") && c.includes("level4"))).toBe(false);
  });

  it("IT-GR-03: detects SQL tables without crashing on DDL", () => {
    const g = extractStaticGraph(SHOP);
    const tables = g.nodes.filter((n) => n.kind === "db_table").map((n) => n.id);
    for (const t of ["products", "inventory", "users", "carts", "cart_items", "orders", "sales_summary"]) {
      expect(tables).toContain(`db:${t}`);
    }
  });

  it("IT-GR-04: every impacted node carries a witness path", () => {
    const g = extractStaticGraph(SHOP);
    const patch = readFileSync(join(ROOT, "demo", "prs", "PR-00.patch"), "utf8");
    const impact = computeImpact(g, parsePatchAddedLines(patch));
    expect(impact.staticImpacted).toContain("route:POST /checkout");
    for (const id of impact.staticImpacted) {
      expect(impact.paths[id], `missing path for ${id}`).toBeDefined();
      expect((impact.paths[id] as string[]).length).toBeGreaterThan(0);
    }
  });

  it("IT-GR-04b (blind spot): PR-00 does not statically impact /reports/sales", () => {
    const g = extractStaticGraph(SHOP);
    const patch = readFileSync(join(ROOT, "demo", "prs", "PR-00.patch"), "utf8");
    const impact = computeImpact(g, parsePatchAddedLines(patch));
    expect(impact.staticImpacted).not.toContain("route:GET /reports/sales");
  });

  it("IT-GR-04c: PR-05 config change impacts checkout and shipping quote", () => {
    const g = extractStaticGraph(SHOP);
    const patch = readFileSync(join(ROOT, "demo", "prs", "PR-05.patch"), "utf8");
    const impact = computeImpact(g, parsePatchAddedLines(patch));
    expect(impact.staticImpacted).toContain("route:POST /checkout");
    expect(impact.staticImpacted).toContain("route:GET /shipping/quote");
  });

  it("IT-GR-05: syntax error degrades to partial graph, never throws", () => {
    expect(() => extractStaticGraph(BAD)).not.toThrow();
    const g = extractStaticGraph(BAD);
    expect(g.nodes.length).toBeGreaterThanOrEqual(0);
  });

  it("IT-GR-06: same tree yields identical JSON bytes", () => {
    const a = JSON.stringify(extractStaticGraph(SHOP));
    const b = JSON.stringify(extractStaticGraph(SHOP));
    expect(a).toBe(b);
  });
});

describe("JS extractor (F-18, allowJs, no tsconfig)", () => {
  const MINI_JS = join(HERE, "fixtures", "shop-mini-js");

  it("IT-GR-JS-01: discovers routes with prefixes on the CJS fixture", () => {
    const g = extractStaticGraph(MINI_JS);
    const routes = g.nodes.filter((n) => n.kind === "route").map((n) => n.id);
    expect(routes).toContain("route:GET /api/items");
    expect(routes).toContain("route:GET /health");
  });

  it("IT-GR-JS-02: CommonJS call edges stop at depth 3", () => {
    const g = extractStaticGraph(MINI_JS);
    const calls = g.edges.filter((e) => e.type === "calls").map((e) => `${e.from} -> ${e.to}`);
    expect(calls.some((c) => c.includes("service.js:deeper"))).toBe(true);
    expect(calls.some((c) => c.includes(":deeper") && c.includes("level4"))).toBe(false);
  });

  it("IT-GR-JS-03: deterministic bytes; .test.js files excluded", () => {
    const a = JSON.stringify(extractStaticGraph(MINI_JS));
    const b = JSON.stringify(extractStaticGraph(MINI_JS));
    expect(a).toBe(b);
    expect(a).not.toContain("stray.test.js");
    expect(a).not.toContain("/phantom");
  });
});
