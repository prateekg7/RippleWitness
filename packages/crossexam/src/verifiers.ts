import type { ClaimType, ClaimVerdict } from "@ripplewitness/core";

export interface VerifyClaim {
  id: string;
  type: ClaimType;
  text: string;
  routes: string[];
  symbol?: string;
  route?: string;
  breaking?: boolean;
}

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface VerifyEvidence {
  observedChanged: Set<string>;
  exercised: Set<string>;
  /** Symbols (functions) and route ids present in the head tree. */
  headSymbols: Set<string>;
  /** Route id -> base-vs-head field changes (empty when unchanged). */
  fieldDiffs: Map<string, FieldChange[]>;
}

export interface VerifyResult {
  claimId: string;
  verdict: ClaimVerdict;
  reason: string;
}

const EXCLUSIVE_RE = /\b(only|nothing else|just|solely|exclusively)\b/i;

/** Route family: strip /:param segments so orders/:id groups with orders. */
export function familyOf(routeId: string): string {
  return routeId.replace(/\/:[^/\s]*/g, "");
}

function families(routes: string[]): Set<string> {
  return new Set(routes.map(familyOf));
}

function verifyScope(claim: VerifyClaim, ev: VerifyEvidence): VerifyResult {
  const declared = [...new Set(claim.routes)];
  if (declared.length === 0) {
    return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: "no routes declared" };
  }
  const unknown = declared.filter((r) => !ev.exercised.has(r) && ![...ev.exercised].some((e) => familyOf(e) === familyOf(r)));
  const exclusive = EXCLUSIVE_RE.test(claim.text);
  const obsFam = families([...ev.observedChanged]);
  const decFam = families(declared);
  if (exclusive) {
    const outside = [...obsFam].filter((f) => !decFam.has(f));
    if (outside.length > 0) {
      return { claimId: claim.id, verdict: "CONTRADICTED", reason: `changes outside scope: ${outside.sort().join(",")}` };
    }
    const anyDeclaredChanged = [...decFam].some((f) => obsFam.has(f));
    if (!anyDeclaredChanged) {
      return { claimId: claim.id, verdict: "CONTRADICTED", reason: "no declared route changed" };
    }
    return { claimId: claim.id, verdict: "SUPPORTED", reason: "all changes within declared scope" };
  }
  // Inclusive: every declared route must have changed.
  for (const r of declared) {
    const fam = familyOf(r);
    const exercised = ev.exercised.has(r) || [...ev.exercised].some((e) => familyOf(e) === fam);
    if (!exercised) return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: `undeclared evidence: ${r}` };
    const changed = ev.observedChanged.has(r) || [...ev.observedChanged].some((e) => familyOf(e) === fam);
    if (!changed) return { claimId: claim.id, verdict: "CONTRADICTED", reason: `${r} did not change` };
  }
  void unknown;
  return { claimId: claim.id, verdict: "SUPPORTED", reason: "every declared route changed" };
}

function verifyBehaviorUnchanged(claim: VerifyClaim, ev: VerifyEvidence): VerifyResult {
  if (claim.routes.length === 0) {
    return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: "no routes declared" };
  }
  for (const r of claim.routes) {
    if (!ev.exercised.has(r)) {
      return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: `${r} not exercised` };
    }
    if (ev.observedChanged.has(r)) {
      return { claimId: claim.id, verdict: "CONTRADICTED", reason: `${r} changed` };
    }
  }
  return { claimId: claim.id, verdict: "SUPPORTED", reason: "all named routes unchanged" };
}

function verifyImplemented(claim: VerifyClaim, ev: VerifyEvidence): VerifyResult {
  const target = claim.symbol ?? claim.route ?? "";
  if (!target) return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: "no symbol or route named" };
  if (!ev.headSymbols.has(target)) {
    return { claimId: claim.id, verdict: "CONTRADICTED", reason: `${target} absent from head` };
  }
  // Present: needs behavioral evidence (>=1 scenario shows new/changed behavior).
  if (claim.route) {
    if (!ev.exercised.has(claim.route)) {
      return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: `${claim.route} not exercised` };
    }
    if (!ev.observedChanged.has(claim.route)) {
      return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: `${claim.route} shows no new behavior` };
    }
    return { claimId: claim.id, verdict: "SUPPORTED", reason: `${claim.route} exists and behaves anew` };
  }
  if (ev.observedChanged.size === 0) {
    return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: `${target} exists but nothing changed` };
  }
  return { claimId: claim.id, verdict: "SUPPORTED", reason: `${target} exists with changed behavior` };
}

function isBreaking(changes: FieldChange[]): boolean {
  for (const c of changes) {
    if (c.before !== undefined && c.after === undefined) return true; // removed field
    if (Array.isArray(c.before) && Array.isArray(c.after) && c.before.length !== c.after.length) return true;
    if (c.path === "$.status") {
      const b = Math.floor(Number(c.before) / 100);
      const a = Math.floor(Number(c.after) / 100);
      if (b !== a) return true; // status class change (e.g. 401 -> 200)
    }
  }
  return false;
}

function verifyApiCompat(claim: VerifyClaim, ev: VerifyEvidence): VerifyResult {
  const breakingRoutes: string[] = [];
  for (const [route, changes] of ev.fieldDiffs) {
    if (isBreaking(changes)) breakingRoutes.push(route);
  }
  const claimsNoBreak = claim.breaking === false || /no breaking/i.test(claim.text);
  if (claimsNoBreak) {
    if (breakingRoutes.length > 0) {
      return {
        claimId: claim.id,
        verdict: "CONTRADICTED",
        reason: `breaking changes: ${breakingRoutes.sort().join(",")}`,
      };
    }
    return { claimId: claim.id, verdict: "SUPPORTED", reason: "no breaking changes observed" };
  }
  return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: "unsupported API_COMPAT phrasing" };
}

/** TRD §7.7 deterministic claim verifiers. Pure. */
export function verifyClaim(claim: VerifyClaim, ev: VerifyEvidence): VerifyResult {
  switch (claim.type) {
    case "SCOPE":
      return verifyScope(claim, ev);
    case "BEHAVIOR_UNCHANGED":
      return verifyBehaviorUnchanged(claim, ev);
    case "IMPLEMENTED":
      return verifyImplemented(claim, ev);
    case "API_COMPAT":
      return verifyApiCompat(claim, ev);
    case "TESTS":
      return { claimId: claim.id, verdict: "UNVERIFIABLE", reason: "TESTS needs CI evidence (P1)" };
  }
}

export function verifyAll(claims: VerifyClaim[], ev: VerifyEvidence): VerifyResult[] {
  return claims.map((c) => verifyClaim(c, ev));
}
