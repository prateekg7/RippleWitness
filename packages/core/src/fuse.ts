import type { ClaimEvidence, FusedNode, NodeStatus, RouteEvidence } from "./types.js";

/**
 * TRD §7.5 fusion. Pure. Evaluation order per route:
 * SURPRISE > CONTRADICTED > CONFIRMED/CLEARED > UNVERIFIED > QUIET,
 * with DIFF for added/removed routes and CONTRADICTED from claim verdicts.
 */
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
