import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPythonGraph } from "./python.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY = join(HERE, "fixtures", "shop-py");

describe("Python extractor (F-20, stdlib ast)", () => {
  it("IT-GR-PY-01: FastAPI decorator routes with prefixes and {param} normalization", async () => {
    const g = await extractPythonGraph(PY);
    const routes = g.nodes.filter((n) => n.kind === "route").map((n) => n.id);
    expect(routes).toContain("route:GET /api/items/:sku");
    expect(routes).toContain("route:POST /api/checkout");
    expect(routes).toContain("route:GET /health");
  });

  it("IT-GR-PY-02: Flask @route with methods list and blueprint prefixes", async () => {
    const g = await extractPythonGraph(PY);
    const routes = g.nodes.filter((n) => n.kind === "route").map((n) => n.id);
    expect(routes).toContain("route:GET /v1/items/:sku");
    expect(routes).toContain("route:GET /legacy");
    expect(routes).toContain("route:POST /legacy");
  });

  it("IT-GR-PY-03: sqlite3 tables, os.environ reads, depth-3 call cap", async () => {
    const g = await extractPythonGraph(PY);
    expect(g.nodes.map((n) => n.id)).toContain("db:products");
    expect(g.nodes.map((n) => n.id)).toContain("config:env:PAGE_LIMIT");
    const calls = g.edges.filter((e) => e.type === "calls").map((e) => `${e.from} -> ${e.to}`);
    expect(calls.some((c) => c.includes("service.py:deeper"))).toBe(true);
    expect(calls.some((c) => c.includes(":deeper") && c.includes("level4"))).toBe(false);
  });

  it("IT-GR-PY-04: deterministic bytes; getattr dispatch yields no static edge", async () => {
    const a = JSON.stringify(await extractPythonGraph(PY));
    const b = JSON.stringify(await extractPythonGraph(PY));
    expect(a).toBe(b);
    const g = await extractPythonGraph(PY);
    const fromDynamic = g.edges.filter((e) => e.from === "fn:app_fastapi.py:dynamic");
    expect(fromDynamic).toHaveLength(0);
  });
});
