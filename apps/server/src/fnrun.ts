import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { createWorktree, removeWorktree, runComputeSide, valuesMatch } from "@ripplewitness/replay";
import { getArtifact, putArtifact } from "./store.js";

export interface FnRunRequest {
  fn: string;
  args?: unknown[] | undefined;
  kwargs?: Record<string, unknown> | undefined;
  predictedBase?: unknown;
  predictedHead?: unknown;
}

export interface FnSide {
  ok: boolean;
  value: unknown;
}

export interface FnRunResult {
  fn: string;
  base: FnSide;
  head: FnSide;
  baseHit: boolean | null;
  headHit: boolean | null;
  /** Whether base and head actually differ (null when either side errored). */
  changed: boolean | null;
}

export interface FnRunInputs {
  repoPath: string;
  baseRef: string;
  headRef: string;
  appDir?: string;
  seedDbRel?: string;
  language: "node" | "python";
}

/** Validate an fn target before it reaches a worktree. Pure. */
export function validateFnTarget(fn: string, language: "node" | "python"): { ok: true } | { ok: false; error: string } {
  if (language === "python") {
    return /^[A-Za-z0-9_.]+:[A-Za-z0-9_]+$/.test(fn) ? { ok: true } : { ok: false, error: "want module:function" };
  }
  const m = /^([^#]+)#([A-Za-z_$][\w$]*)$/.exec(fn);
  if (!m) return { ok: false, error: "want file#export" };
  if (!/\.[mc]?[jt]sx?$/.test(m[1] as string)) return { ok: false, error: "file must be .js/.mjs/.ts/.tsx" };
  if ((m[1] as string).split("/").includes("..")) return { ok: false, error: "path escapes app dir" };
  return { ok: true };
}

/**
 * F-10 Predict-then-Run: call one function on base and head worktrees and
 * grade the reviewer's predicted outputs against the actual values.
 * Never throws: side errors land inside the FnSide envelopes.
 */
export async function runFnBothSides(
  db: Database.Database,
  runId: string,
  workRoot: string,
  inputs: FnRunInputs,
  req: FnRunRequest,
): Promise<FnRunResult> {
  const valid = validateFnTarget(req.fn, inputs.language);
  if (!valid.ok) {
    return {
      fn: req.fn,
      base: { ok: false, value: { error: valid.error } },
      head: { ok: false, value: { error: valid.error } },
      baseHit: null,
      headHit: null,
      changed: null,
    };
  }
  const root = join(workRoot, `fnrun-${runId}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const baseWt = join(root, "wt-base");
  const headWt = join(root, "wt-head");
  const appDir = inputs.appDir && inputs.appDir !== "." ? inputs.appDir : ".";
  try {
    await createWorktree(inputs.repoPath, inputs.baseRef, baseWt);
    await createWorktree(inputs.repoPath, inputs.headRef, headWt);
  } catch (err) {
    return failed(req.fn, `worktree: ${String(err).slice(0, 200)}`);
  }
  // Defense in depth with the shim: the node target must stay inside the app dir.
  if (inputs.language === "node") {
    const file = req.fn.split("#")[0] as string;
    for (const wt of [baseWt, headWt]) {
      const appRoot = `${resolve(wt, appDir)}${sep}`;
      if (!resolve(wt, appDir, file).startsWith(appRoot)) return failed(req.fn, "path escapes app dir");
    }
  }
  try {
    const scenario = {
      id: "fnrun",
      group: "fnrun",
      routeIds: [`fn:${req.fn}`],
      kind: "compute" as const,
      target: req.fn,
      args: req.args ?? [],
      kwargs: req.kwargs ?? {},
    };
    const common = {
      workRoot: root,
      seedDb: join(baseWt, appDir, inputs.seedDbRel ?? "seed/seed.db"),
      stepTimeoutMs: 15000,
      runtime: inputs.language === "node" ? ("node" as const) : ("python" as const),
    };
    const [b, h] = await Promise.all([
      runComputeSide(join(baseWt, appDir), [scenario], { ...common, side: "base" }),
      runComputeSide(join(headWt, appDir), [scenario], { ...common, side: "head" }),
    ]);
    const base = sideOf(b.steps[0]?.status, b.steps[0]?.body);
    const head = sideOf(h.steps[0]?.status, h.steps[0]?.body);
    const result: FnRunResult = {
      fn: req.fn,
      base,
      head,
      baseHit: req.predictedBase === undefined || !base.ok ? (req.predictedBase === undefined ? null : false) : valuesMatch(req.predictedBase, base.value),
      headHit: req.predictedHead === undefined || !head.ok ? (req.predictedHead === undefined ? null : false) : valuesMatch(req.predictedHead, head.value),
      changed: base.ok && head.ok ? !valuesMatch(base.value, head.value) : null,
    };
    const log = getArtifact<FnRunResult[]>(db, runId, "fnRuns") ?? [];
    putArtifact(db, runId, "fnRuns", [...log, result].slice(-50));
    return result;
  } finally {
    await removeWorktree(inputs.repoPath, baseWt).catch(() => {});
    await removeWorktree(inputs.repoPath, headWt).catch(() => {});
  }
}

function sideOf(status: number | undefined, body: unknown): FnSide {
  return status === 200 ? { ok: true, value: body } : { ok: false, value: body };
}

function failed(fn: string, error: string): FnRunResult {
  return {
    fn,
    base: { ok: false, value: { error } },
    head: { ok: false, value: { error } },
    baseHit: null,
    headHit: null,
    changed: null,
  };
}
