import type { ClaimEvidence, FusedNode, NodeStatus, RouteEvidence } from "./types.js";

/**
 * TRD §7.5 fusion. Pure. Evaluation order per route:
 * SURPRISE > CONTRADICTED > CONFIRMED/CLEARED > UNVERIFIED > QUIET,
 * with DIFF for added/removed routes and CONTRADICTED from claim verdicts.
 */
function parseRouteId(id: string): { method: string; segments: string[] } | null {
  const m = /^route:([A-Z]+) (.+)$/.exec(id);
  if (!m) return null;
  return { method: m[1] as string, segments: (m[2] as string).split("/") };
}

/**
 * True iff a static route pattern (`route:GET /:name/:id`) can serve the
 * evidence route id. `:param` segments match any single segment; an evidence
 * segment that is itself a `:param` is compatible with a literal pattern
 * segment (the evidence id is then a template covering it).
 */
export function routePatternMatches(patternRouteId: string, routeId: string): boolean {
  const p = parseRouteId(patternRouteId);
  const r = parseRouteId(routeId);
  if (!p || !r || p.method !== r.method || p.segments.length !== r.segments.length) return false;
  return p.segments.every(
    (seg, i) => (seg.startsWith(":") && (r.segments[i] as string).length > 0) || seg === r.segments[i] || (r.segments[i] as string).startsWith(":"),
  );
}

/**
 * Static impact for one evidence route, inheriting from a matching static
 * route pattern when there is no exact hit (runtime-registered subjects:
 * the graph knows `GET /:name`, execution observes `GET /posts`). The
 * witness path is the pattern's path with the concrete route appended.
 * Pure; candidate choice is deterministic (fewest params, then id order).
 */
export function inheritStaticImpact(
  routeId: string,
  impact: { staticImpacted: string[]; inDiff: string[]; paths: Record<string, string[]> },
): { staticImpacted: boolean; inDiff: boolean; impactPath: string[] } {
  const impacted = new Set(impact.staticImpacted);
  const inDiff = new Set(impact.inDiff);
  if (impacted.has(routeId) || inDiff.has(routeId)) {
    return { staticImpacted: impacted.has(routeId), inDiff: inDiff.has(routeId), impactPath: impact.paths[routeId] ?? [] };
  }
  const paramCount = (id: string): number => (parseRouteId(id)?.segments.filter((s) => s.startsWith(":")).length ?? 0);
  const pick = impact.staticImpacted
    .filter((id) => id.startsWith("route:") && routePatternMatches(id, routeId))
    .sort((a, b) => paramCount(a) - paramCount(b) || (a < b ? -1 : 1))[0];
  if (!pick) return { staticImpacted: false, inDiff: false, impactPath: [] };
  return { staticImpacted: true, inDiff: inDiff.has(pick), impactPath: [...(impact.paths[pick] ?? [pick]), routeId] };
}

export function fuseRoutes(routes: RouteEvidence[], claims: ClaimEvidence[], opts: { staticUnknown?: boolean } = {}): FusedNode[] {
  const contradictedBy = new Map<string, string[]>();
  for (const c of claims) {
    if (c.verdict !== "CONTRADICTED") continue;
    for (const r of c.routes) {
      contradictedBy.set(r, [...(contradictedBy.get(r) ?? []), c.claimId]);
    }
  }
  return routes
    .map((r): FusedNode => {
      const contra = (contradictedBy.get(r.routeId) ?? []).sort();
      let status: NodeStatus;
      if (r.isNew) {
        status = "DIFF";
      } else if (opts.staticUnknown && contra.length > 0 && r.exercised) {
        status = "CONTRADICTED";
      } else if (opts.staticUnknown && r.exercised && r.observedChanged) {
        // Dynamic-only (J-05): report observed outcomes without static claims.
        // No SURPRISE — surprise asserts "no static path", which needs a static pass.
        status = "CHANGED";
      } else if (opts.staticUnknown && r.exercised) {
        status = "UNCHANGED";
      } else if (opts.staticUnknown) {
        status = "UNCOVERED";
      } else if (r.exercised && r.observedChanged && !r.staticImpacted) {
        status = "SURPRISE";
      } else if (contra.length > 0 && r.exercised) {
        status = "CONTRADICTED";
      } else if (r.exercised && r.observedChanged && r.staticImpacted) {
        status = "CONFIRMED";
      } else if (r.exercised && !r.observedChanged && r.staticImpacted) {
        status = "CLEARED";
      } else if (!r.exercised && r.staticImpacted) {
        status = "UNVERIFIED";
      } else {
        status = "QUIET";
      }
      return {
        routeId: r.routeId,
        status,
        exercised: r.exercised,
        observedChanged: r.observedChanged,
        staticImpacted: r.staticImpacted,
        inDiff: r.inDiff,
        isNew: r.isNew,
        surprise: status === "SURPRISE",
        contradictedBy: contra,
      };
    })
    .sort((a, b) => (a.routeId < b.routeId ? -1 : 1));
}
