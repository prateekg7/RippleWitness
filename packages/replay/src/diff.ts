import { normalizeBody } from "./normalize.js";
import type { StepObservation } from "./types.js";

export type DiffKind = "status" | "body" | "headers" | "db" | "outbound";

export interface FieldDiff {
  kind: DiffKind;
  path: string;
  before: unknown;
  after: unknown;
}

/** A numeric difference inside tolerance: reported, never counted as a change. */
export interface ToleratedField {
  path: string;
  before: number;
  after: number;
  deviation: number;
}

export interface StepDiff {
  scenarioId: string;
  stepIndex: number;
  method: string;
  path: string;
  changed: boolean;
  kinds: DiffKind[];
  diffs: FieldDiff[];
  tolerated: ToleratedField[];
}

export interface ToleranceSpec {
  /** JSONPath prefix (`$.scores` covers `$.scores`, `$.scores[0]`, `$.scores.w`…). */
  path: string;
  rtol?: number | undefined;
  atol?: number | undefined;
  /** When true, NaN counts equal to NaN at this path. */
  nanEqual?: boolean | undefined;
}

export interface DiffOptions {
  mask?: string[];
  /** Route ids whose array order is insignificant (TRD _routes.json `unordered`). */
  unorderedRoutes?: string[];
  /** Map "scenarioId:stepIndex" -> route id for the unordered lookup. */
  stepRoute?: (scenarioId: string, stepIndex: number) => string | null;
  /** Numeric tolerance specs (F-21). Only numeric leaves compare tolerantly. */
  tolerances?: ToleranceSpec[];
}

export const DEFAULT_RTOL = 1e-5;
export const DEFAULT_ATOL = 1e-8;

/** `numpy.allclose` semantics: |a−b| ≤ atol + rtol·|b|. Pure. */
export function numbersClose(
  a: number,
  b: number,
  spec: Pick<ToleranceSpec, "rtol" | "atol" | "nanEqual"> = {},
): { close: boolean; deviation: number } {
  if (a === b) return { close: true, deviation: 0 };
  if (spec.nanEqual === true && Number.isNaN(a) && Number.isNaN(b)) return { close: true, deviation: 0 };
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { close: false, deviation: Number.POSITIVE_INFINITY };
  const deviation = Math.abs(a - b);
  const rtol = spec.rtol ?? DEFAULT_RTOL;
  const atol = spec.atol ?? DEFAULT_ATOL;
  return { close: deviation <= atol + rtol * Math.abs(b), deviation };
}

function specFor(path: string, tolerances: ToleranceSpec[]): ToleranceSpec | null {
  let best: ToleranceSpec | null = null;
  for (const t of tolerances) {
    if (path === t.path || path.startsWith(`${t.path}.`) || path.startsWith(`${t.path}[`)) {
      if (!best || t.path.length > best.path.length) best = t;
    }
  }
  return best;
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

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  kind: DiffKind,
  out: FieldDiff[],
  tolerated: ToleratedField[],
  tolerances: ToleranceSpec[],
): void {
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
        tolerated,
        tolerances,
      );
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && specFor(path, tolerances)) {
    // Tolerance-gated arrays: shape change is a real diff; values recurse elementwise.
    if (before.length !== after.length) {
      out.push({ kind, path: path || "$", before: `array[${before.length}]`, after: `array[${after.length}]` });
      return;
    }
    for (let i = 0; i < before.length; i++) {
      diffValues(before[i], after[i], `${path || "$"}[${i}]`, kind, out, tolerated, tolerances);
    }
    return;
  }
  if (typeof before === "number" && typeof after === "number") {
    const spec = specFor(path, tolerances);
    if (spec) {
      const { close, deviation } = numbersClose(before, after, spec);
      if (close) {
        tolerated.push({ path: path || "$", before, after, deviation });
        return;
      }
    }
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
  const tolerated: ToleratedField[] = [];
  const tolerances = opts.tolerances ?? [];
  if (unordered) {
    diffValues(sortDeep(nb), sortDeep(nh), "$", "body", before, tolerated, tolerances);
  } else {
    diffValues(nb, nh, "$", "body", before, tolerated, tolerances);
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
    tolerated: tolerated.sort((x, y) => (x.path < y.path ? -1 : 1)),
  };
}

export interface RouteDiff {
  routeId: string;
  scenarioIds: string[];
  changed: boolean;
  kinds: DiffKind[];
  diffs: FieldDiff[];
  tolerated: ToleratedField[];
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
  // Compute observations (F-23) carry their fn: id as the path; match exactly.
  if (method === "CALL" && declared.includes(path)) return [path];
  const bare = path.split("?")[0] as string;
  const matches = declared.filter((rid) => {
    const m = /^route:([A-Z]+) (.+)$/.exec(rid);
    if (!m || m[1] !== method) return false;
    // Escape regex metacharacters in literal segments; `:param` matches one segment.
    const pattern = `^${(m[2] as string)
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}$`;
    return new RegExp(pattern).test(bare);
  });
  return matches.length > 0 ? matches : declared;
}

/** Aggregate step diffs per route id (step-level attribution). */
export function aggregateByRoute(
  stepDiffs: StepDiff[],
  scenarioRoutes: Map<string, string[]>,
): RouteDiff[] {
  const byRoute = new Map<
    string,
    { scenarios: Set<string>; changed: boolean; kinds: Set<DiffKind>; diffs: FieldDiff[]; tolerated: ToleratedField[] }
  >();
  for (const d of stepDiffs) {
    const declared = scenarioRoutes.get(d.scenarioId) ?? [];
    // Every declared route gets an entry (coverage); only the step's own
    // route inherits a change.
    for (const route of declared) {
      if (!byRoute.has(route)) {
        byRoute.set(route, { scenarios: new Set(), changed: false, kinds: new Set(), diffs: [], tolerated: [] });
      }
      (byRoute.get(route) as { scenarios: Set<string> }).scenarios.add(d.scenarioId);
    }
    for (const route of resolveStepRoutes(d.method, d.path, declared)) {
      const acc = byRoute.get(route);
      if (!acc) continue;
      acc.tolerated.push(...(d.tolerated ?? []));
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
      tolerated: acc.tolerated.sort((x, y) => (x.path < y.path ? -1 : 1)),
    }));
}
