import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { aggregateByRoute, createWorktree, diffSteps, loadScenarios, removeWorktree, runReplay } from "@ripplewitness/replay";
import type { CanaryCandidate } from "./operators.js";

export interface CanaryVerdict {
  accepted: boolean;
  reason: string;
  changedRoutes: string[];
}

/**
 * Execution validation (TRD §7.10): the canary lives only in a temp branch +
 * temp worktrees — never in the repo, index, or any kept branch. A mutation
 * with no observable behavior change is rejected.
 */
export async function validateCanary(opts: {
  repoPath: string;
  baseRef: string;
  candidate: CanaryCandidate;
  scenariosDir: string;
  seedDbRel: string;
  appDir?: string;
  workRoot: string;
}): Promise<CanaryVerdict> {
  const branch = `rw-canary-${Date.now()}`;
  const setupWt = join(opts.workRoot, "wt-canary-setup");
  try {
    await createWorktree(opts.repoPath, opts.baseRef, setupWt);
    const target = join(setupWt, opts.appDir ?? ".", opts.candidate.file);
    writeFileSync(target, opts.candidate.patched);
    await execa("git", ["checkout", "-qb", branch], { cwd: setupWt });
    await execa("git", ["add", "-A"], { cwd: setupWt });
    await execa("git", ["commit", "-qm", `canary ${opts.candidate.operator} ${opts.candidate.file}:${opts.candidate.line}`], {
      cwd: setupWt,
    });
  } catch (err) {
    await removeWorktree(opts.repoPath, setupWt).catch(() => {});
    return { accepted: false, reason: `canary commit failed: ${String(err)}`, changedRoutes: [] };
  }
  try {
    const replay = await runReplay({
      repoPath: opts.repoPath,
      baseRef: opts.baseRef,
      headRef: branch,
      scenariosDir: opts.scenariosDir,
      seedDbRel: opts.seedDbRel,
      ...(opts.appDir ? { appDir: opts.appDir } : {}),
      workRoot: join(opts.workRoot, "wt-canary-run"),
    });
    if (!replay.ok) {
      return { accepted: false, reason: `canary broke the app (${replay.error.stage}: ${replay.error.message.slice(0, 120)})`, changedRoutes: [] };
    }
    const scenarios = loadScenarios(opts.scenariosDir);
    const scenarioRoutes = new Map(scenarios.map((s) => [s.id, s.routeIds]));
    const stepDiffs = replay.base.steps.map((s, i) =>
      diffSteps(s, replay.head.steps[i] as (typeof replay.head.steps)[number]),
    );
    const changed = aggregateByRoute(stepDiffs, scenarioRoutes).filter((r) => r.changed);
    if (changed.length === 0) {
      return { accepted: false, reason: "no observable behavior change", changedRoutes: [] };
    }
    return {
      accepted: true,
      reason: `observable change on ${changed.length} route(s)`,
      changedRoutes: changed.map((r) => r.routeId).sort(),
    };
  } finally {
    await removeWorktree(opts.repoPath, setupWt).catch(() => {});
    await execa("git", ["branch", "-D", branch], { cwd: opts.repoPath }).catch(() => {});
  }
}
