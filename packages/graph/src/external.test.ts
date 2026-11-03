import { describe, expect, it } from "vitest";
import { parseExternalGraph } from "./external.js";

const good = {
  nodes: [
    { id: "route:GET /a", kind: "route", label: "GET /a" },
    { id: "fn:h", kind: "handler", label: "h", file: "src/h.ts", range: [1, 9] },
  ],
  edges: [{ from: "route:GET /a", to: "fn:h", type: "calls", confidence: "EXTRACTED" }],
};

describe("external graph import (M-11)", () => {
  it("CT-GX-01: accepts a well-formed graph", () => {
    const out = parseExternalGraph(good);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.graph.nodes).toHaveLength(2);
    expect(out.graph.edges).toHaveLength(1);
  });

  it("CT-GX-02: rejects dangling edges, duplicate ids, and bad shapes", () => {
    expect(parseExternalGraph({ nodes: good.nodes, edges: [{ from: "route:GET /a", to: "missing", type: "calls", confidence: "EXTRACTED" }] })).toEqual({
      ok: false,
      error: "dangling_edge_to:missing",
    });
    expect(parseExternalGraph({ nodes: [good.nodes[0], good.nodes[0]], edges: [] })).toEqual({
      ok: false,
      error: "duplicate_node:route:GET /a",
    });
    const badKind = parseExternalGraph({ nodes: [{ id: "x", kind: "wizard", label: "x" }], edges: [] });
    expect(badKind.ok).toBe(false);
    expect(parseExternalGraph({ nope: 1 }).ok).toBe(false);
  });
});
