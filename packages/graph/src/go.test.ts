import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractGoGraph } from "./go.js";
import { detectLanguage } from "./language.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shop-mini-go");

// 120s: the first `go run` on a cold toolchain compiles slowly (one-time).
describe("go extractor (IT-GR-GO-01..04)", () => {
  it("detects go.mod subjects", () => {
    expect(detectLanguage(FIX)).toBe("go");
  });

  it("extracts routes incl. method patterns, params, ctors, anon handlers", async () => {
    const g = await extractGoGraph(FIX);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("route:GET /a");
    expect(ids).toContain("route:POST /b/:id");
    expect(ids).toContain("route:GET /anon");
    expect(ids).toContain("fn:main.go:handleA");
    expect(ids).toContain("fn:main.go:helper");
    const edgeSet = new Set(g.edges.map((e) => `${e.from} ${e.type}> ${e.to}`));
    expect(edgeSet).toContain("route:GET /a calls> fn:main.go:handleA");
    expect(edgeSet).toContain("fn:main.go:handleA calls> fn:main.go:helper");
    expect(edgeSet).toContain("route:POST /b/:id calls> fn:main.go:handleB");
  });

  it("captures config reads and db writes", async () => {
    const g = await extractGoGraph(FIX);
    const edgeSet = new Set(g.edges.map((e) => `${e.from} ${e.type}> ${e.to}`));
    expect(edgeSet).toContain("fn:main.go:handleA config> config:env:RATE");
    expect(edgeSet).toContain("fn:main.go:handleB writes> db:orders");
    expect(g.nodes.find((n) => n.id === "db:orders")?.kind).toBe("db_table");
  });

  it("is deterministic byte-for-byte", async () => {
    const a = JSON.stringify(await extractGoGraph(FIX));
    const b = JSON.stringify(await extractGoGraph(FIX));
    expect(a).toBe(b);
  });
}, 120000);
