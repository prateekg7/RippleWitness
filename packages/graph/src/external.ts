import { z } from "zod";
import type { StaticGraph } from "./types.js";

/**
 * External graph import (M-11): consume a precomputed static graph (e.g. from
 * a third-party extractor for an unsupported language) instead of running the
 * built-in extractor. Validated strictly: unknown node kinds, dangling edges,
 * and duplicate ids are rejected, never silently repaired.
 *
 * Caps (1k nodes / 4k edges) keep payloads inside the 1mb API body limit.
 */

export const ExternalGraphSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(500),
        kind: z.enum(["route", "handler", "service", "db_table", "config"]),
        label: z.string().max(500),
        file: z.string().max(500).optional(),
        range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
      }),
    )
    .max(1000),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.enum(["calls", "reads", "writes", "config"]),
        confidence: z.enum(["EXTRACTED", "INFERRED"]),
      }),
    )
    .max(4000),
});

export function parseExternalGraph(json: unknown): { ok: true; graph: StaticGraph } | { ok: false; error: string } {
  const parsed = ExternalGraphSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_graph" };
  const ids = new Set<string>();
  for (const n of parsed.data.nodes) {
    if (ids.has(n.id)) return { ok: false, error: `duplicate_node:${n.id}` };
    ids.add(n.id);
  }
  for (const e of parsed.data.edges) {
    if (!ids.has(e.from)) return { ok: false, error: `dangling_edge_from:${e.from}` };
    if (!ids.has(e.to)) return { ok: false, error: `dangling_edge_to:${e.to}` };
  }
  // Rebuild without explicit-undefined keys (exactOptionalPropertyTypes).
  return {
    ok: true,
    graph: {
      nodes: parsed.data.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        ...(n.file !== undefined ? { file: n.file } : {}),
        ...(n.range !== undefined ? { range: n.range } : {}),
      })),
      edges: parsed.data.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, confidence: e.confidence })),
    },
  };
}
