import { normalizeBody } from "./normalize.js";
import type { StepObservation } from "./types.js";

export type DiffKind = "status" | "body" | "headers" | "db" | "outbound";

export interface FieldDiff {
  kind: DiffKind;
  path: string;
  before: unknown;
  after: unknown;
}

export interface StepDiff {
  scenarioId: string;
  stepIndex: number;
  method: string;
  path: string;
  changed: boolean;
  kinds: DiffKind[];
  diffs: FieldDiff[];
}

export interface DiffOptions {
  mask?: string[];
  /** Route ids whose array order is insignificant (TRD _routes.json `unordered`). */
  unorderedRoutes?: string[];
  /** Map "scenarioId:stepIndex" -> route id for the unordered lookup. */
  stepRoute?: (scenarioId: string, stepIndex: number) => string | null;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

function diffValues(before: unknown, after: unknown, path: string, kind: DiffKind, out: FieldDiff[]): void {
  const b = JSON.stringify(before);
  const a = JSON.stringify(after);
  if (b === a) return;
  if (
    typeof before === "object" &&
    typeof after === "object" &&
    before !== null &&
    after !== null &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of [...keys].sort()) {
      diffValues(
        (before as Record<string, unknown>)[k],
        (after as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k,
        kind,
        out,
      );
    }
    return;
  }
  out.push({ kind, path: path || "$", before, after });
}

/** Compare one base step against its head twin. Pure. */
export function diffSteps(base: StepObservation, head: StepObservation, opts: DiffOptions = {}): StepDiff {
  const diffs: FieldDiff[] = [];
  const kinds = new Set<DiffKind>();
  if (base.status !== head.status) {
    kinds.add("status");
    diffs.push({ kind: "status", path: "$.status", before: base.status, after: head.status });
  }
  const route = opts.stepRoute?.(base.scenarioId, base.stepIndex) ?? null;
  const unordered = route !== null && (opts.unorderedRoutes ?? []).includes(route);
  const nb = normalizeBody(base.body, opts.mask ?? []);
  const nh = normalizeBody(head.body, opts.mask ?? []);
  const before: FieldDiff[] = [];
  if (unordered) {
    diffValues(sortDeep(nb), sortDeep(nh), "$", "body", before);
  } else {
    diffValues(nb, nh, "$", "body", before);
  }
  if (before.length > 0) {
    kinds.add("body");
    diffs.push(...before);
  }
  const headerKeys = new Set([...Object.keys(base.headers), ...Object.keys(head.headers)]);
  for (const k of [...headerKeys].sort()) {
    if (base.headers[k] !== head.headers[k]) {
      kinds.add("headers");
      diffs.push({ kind: "headers", path: `$.headers.${k}`, before: base.headers[k], after: head.headers[k] });
    }
  }
  return {
    scenarioId: base.scenarioId,
    stepIndex: base.stepIndex,
    method: base.method,
    path: base.path,
    changed: kinds.size > 0,
    kinds: [...kinds].sort(),
    diffs,
  };
}

export interface RouteDiff {
  routeId: string;
  scenarioIds: string[];
  changed: boolean;
  kinds: DiffKind[];
  diffs: FieldDiff[];
}

export interface ScenarioRoutes {
  id: string;
  routeIds: string[];
}

/**
 * Attribute a step to its route by matching method + concrete path against
 * the scenario's declared route ids (`:param` segments match one path part).
 * Falls back to all declared routes when nothing matches (conservative).
 */
export function resolveStepRoutes(
  method: string,
  path: string,
  declared: string[],
): string[] {
  const bare = path.split("?")[0] as string;
  const matches = declared.filter((rid) => {
    const m = /^route:([A-Z]+) (.+)$/.exec(rid);
    if (!m || m[1] !== method) return false;
    const pattern = `^${(m[2] as string).replace(/:[^/]+/g, "[^/]+")}$`;
    return new RegExp(pattern).test(bare);
  });
  return matches.length > 0 ? matches : declared;
}

/** Aggregate step diffs per route id (step-level attribution). */
export function aggregateByRoute(
  stepDiffs: StepDiff[],
  scenarioRoutes: Map<string, string[]>,
): RouteDiff[] {
  const byRoute = new Map<string, { scenarios: Set<string>; changed: boolean; kinds: Set<DiffKind>; diffs: FieldDiff[] }>();
  for (const d of stepDiffs) {
    const declared = scenarioRoutes.get(d.scenarioId) ?? [];
    // Every declared route gets an entry (coverage); only the step's own
    // route inherits a change.
    for (const route of declared) {
      if (!byRoute.has(route)) {
        byRoute.set(route, { scenarios: new Set(), changed: false, kinds: new Set(), diffs: [] });
      }
      (byRoute.get(route) as { scenarios: Set<string> }).scenarios.add(d.scenarioId);
    }
    for (const route of resolveStepRoutes(d.method, d.path, declared)) {
      const acc = byRoute.get(route);
      if (!acc) continue;
      if (d.changed) {
        acc.changed = true;
        for (const k of d.kinds) acc.kinds.add(k);
        acc.diffs.push(...d.diffs);
      }
    }
  }
  return [...byRoute.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([routeId, acc]) => ({
      routeId,
      scenarioIds: [...acc.scenarios].sort(),
      changed: acc.changed,
      kinds: [...acc.kinds].sort(),
      diffs: acc.diffs,
    }));
}
