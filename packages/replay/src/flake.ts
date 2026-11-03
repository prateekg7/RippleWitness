import { diffSteps } from "./diff.js";
import type { DiffOptions } from "./diff.js";
import type { StepObservation } from "./types.js";

/**
 * Auto-mask learning (F-22): diff two runs of the same side and turn every
 * differing body leaf into a `$..key` mask (mask semantics: trailing key only,
 * see normalize.ts). Status/header flaps are NOT maskable — they stay volatile.
 * One pass per run-pair; each additional base run feeds another pass (≤3).
 * Pure.
 */
export function learnMasks(run1: StepObservation[], run2: StepObservation[], opts: DiffOptions = {}): string[] {
  const byKey = new Map(run2.map((s) => [`${s.scenarioId}:${s.stepIndex}`, s]));
  const masks = new Set<string>();
  for (const a of run1) {
    const b = byKey.get(`${a.scenarioId}:${a.stepIndex}`);
    if (!b) continue;
    for (const d of diffSteps(a, b, opts).diffs) {
      if (d.kind !== "body") continue;
      const leaf = d.path.replace(/\[[^\]]*\]/g, "").split(".").pop() ?? "";
      if (leaf && leaf !== "$") masks.add(`$..${leaf}`);
    }
  }
  return [...masks].sort();
}

export interface FlakeResult {
  /** "scenarioId:stepIndex" keys whose two base runs differ. */
  volatileSteps: string[];
  /** Route ids to exclude from observed-changed (any volatile step). */
  volatileRoutes: string[];
}

function stepKey(s: StepObservation): string {
  return `${s.scenarioId}:${s.stepIndex}`;
}

/**
 * Base double-run flake guard (TRD §7.4): any observation that differs
 * between two base runs is volatile and must be excluded from verdicts.
 * Pure — the caller runs base twice and passes both step lists.
 */
export function detectVolatile(
  baseRun1: StepObservation[],
  baseRun2: StepObservation[],
  scenarioRoutes: Map<string, string[]>,
  opts: DiffOptions = {},
): FlakeResult {
  const byKey = new Map(baseRun2.map((s) => [stepKey(s), s]));
  const volatileSteps: string[] = [];
  const volatileRoutes = new Set<string>();
  for (const a of baseRun1) {
    const b = byKey.get(stepKey(a));
    if (!b) {
      // Missing twin: the step cannot be cleared — exclude its routes too.
      volatileSteps.push(stepKey(a));
      for (const r of scenarioRoutes.get(a.scenarioId) ?? []) volatileRoutes.add(r);
      continue;
    }
    const d = diffSteps(a, b, opts);
    if (d.changed) {
      volatileSteps.push(stepKey(a));
      for (const r of scenarioRoutes.get(a.scenarioId) ?? []) volatileRoutes.add(r);
    }
  }
  volatileSteps.sort();
  return { volatileSteps, volatileRoutes: [...volatileRoutes].sort() };
}
