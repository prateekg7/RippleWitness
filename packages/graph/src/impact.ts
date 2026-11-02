import type { ChangedFile, ImpactResult, StaticGraph } from "./types.js";

const IMPACT_DEPTH = 3;

function intersects(range: [number, number] | undefined, lines: Set<number>): boolean {
  if (!range) return false;
  for (let l = range[0]; l <= range[1]; l++) {
    if (lines.has(l)) return true;
  }
  return false;
}

/**
 * TRD §7.1 step 6: staticImpacted = inDiff ∪ reverse-reachable callers
 * (depth ≤ 3) ∪ nodes sharing a db_table/config node with an inDiff node.
 * One witness path is recorded per impacted node.
 */
export function computeImpact(graph: StaticGraph, changed: ChangedFile[]): ImpactResult {
  const byFile = new Map<string, Set<number>>();
  for (const c of changed) byFile.set(c.file, new Set(c.lines));

  const inDiff = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.file) continue;
    const lines = byFile.get(n.file);
    if (lines && intersects(n.range, lines)) inDiff.add(n.id);
  }

  const impacted = new Set<string>(inDiff);
  const paths: Record<string, string[]> = {};
  for (const id of inDiff) paths[id] = [id];

  // db_table/config sharing: nodes adjacent (reads/writes/config) to a
  // shared node that is itself adjacent to an inDiff node. Peers seed the
  // caller BFS below so their routes are reached too.
  const adj = new Map<string, string[]>(); // node -> shared nodes
  const sharedBy = new Map<string, string[]>(); // shared node -> nodes
  for (const e of graph.edges) {
    if (e.type !== "reads" && e.type !== "writes" && e.type !== "config") continue;
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    sharedBy.set(e.to, [...(sharedBy.get(e.to) ?? []), e.from]);
  }
  const touchedShared = new Set<string>();
  for (const id of inDiff) {
    if (sharedBy.has(id)) touchedShared.add(id); // the shared node itself changed
    for (const s of adj.get(id) ?? []) touchedShared.add(s);
  }
  const seeds = new Set<string>(inDiff);
  for (const s of [...touchedShared].sort()) {
    for (const peer of [...(sharedBy.get(s) ?? [])].sort()) {
      if (impacted.has(peer)) continue;
      impacted.add(peer);
      paths[peer] = [peer, `shared:${s}`];
      seeds.add(peer);
    }
  }

  // Reverse adjacency over calls edges only (callers of X).
  const callers = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "calls") continue;
    const list = callers.get(e.to) ?? [];
    list.push(e.from);
    callers.set(e.to, list);
  }
  for (const key of callers.keys()) callers.set(key, [...(callers.get(key) as string[])].sort());
  const queue: { id: string; depth: number }[] = [...seeds].sort().map((id) => ({ id, depth: 0 }));
  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (depth >= IMPACT_DEPTH) continue;
    for (const caller of callers.get(id) ?? []) {
      if (impacted.has(caller)) continue;
      impacted.add(caller);
      paths[caller] = [...(paths[id] as string[]), caller];
      queue.push({ id: caller, depth: depth + 1 });
    }
  }

  return {
    inDiff: [...inDiff].sort(),
    staticImpacted: [...impacted].sort(),
    paths,
  };
}
