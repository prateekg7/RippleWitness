import { diffSteps } from "./diff.js";
import type { DiffOptions } from "./diff.js";
import type { StepObservation } from "./types.js";

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
      volatileSteps.push(stepKey(a));
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
