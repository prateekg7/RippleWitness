import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { FusedNode } from "@ripplewitness/core";
import { dropEvent, findSubscriptions, planAblations, verdictAblation } from "@ripplewitness/crossexam";
import type { AblationCandidate, AblationKind, AblationVerdict } from "@ripplewitness/crossexam";
import { aggregateByRoute, createWorktree, diffSteps, loadScenarios, removeWorktree, runReplay } from "@ripplewitness/replay";
import { getArtifact, putArtifact } from "./store.js";

const exec = promisify(execFile);

export interface AblateRequest {
  routeId: string;
  kind: AblationKind;
  /** Repo-relative file the ablation touches. */
  file: string;
  event?: string | undefined;
}

export interface AblateResult {
  routeId: string;
  ablation: AblationCandidate;
  verdict: AblationVerdict;
  detail: string;
  changedAfter: boolean | null;
}

export interface AblateInputs {
  repoPath: string;
  baseRef: string;
  headRef: string;
  scenariosDir: string;
  appDir?: string;
  seedDbRel?: string;
  appStart?: string[];
  language?: "node" | "python" | "go";
}

/**
 * F-16 Causal Ablation: neutralize one coupling in a third worktree (head +
 * the edit, committed on a detached HEAD — never a branch) and replay
 * base-vs-ablated over the route's scenarios. Never throws.
 */
export async function runAblation(
  db: Database.Database,
  runId: string,
  workRoot: string,
  inputs: AblateInputs,
  req: AblateRequest,
): Promise<AblateResult> {
  const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
  const node = fused.find((n) => n.routeId === req.routeId);
  const ablation: AblationCandidate = {
    kind: req.kind,
    file: req.file,
    ...(req.event ? { event: req.event } : {}),
    reason: "reviewer-named coupling",
  };
  if (!node || !node.exercised || !node.observedChanged) {
    return done(db, runId, { routeId: req.routeId, ablation, verdict: "NO-ABLATION", detail: "route has no observed diff to explain", changedAfter: null });
  }
  if (req.file.includes("..")) {
    return done(db, runId, { routeId: req.routeId, ablation, verdict: "NO-ABLATION", detail: "bad file path", changedAfter: null });
  }
  const root = join(workRoot, `ablate-${runId}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const wt = join(root, "wt-ablated");
  try {
    await createWorktree(inputs.repoPath, inputs.headRef, wt);
  } catch (err) {
    return done(db, runId, {
      routeId: req.routeId, ablation, verdict: "ABLATION-INVALID", detail: `worktree: ${String(err).slice(0, 160)}`, changedAfter: null,
    });
  }
  try {
    const edit = await applyEdit(inputs, wt, req);
    if (!edit.ok) {
      return done(db, runId, { routeId: req.routeId, ablation, verdict: "ABLATION-INVALID", detail: edit.error, changedAfter: null });
    }
    let ablatedSha: string;
    try {
      await exec("git", ["-c", "user.email=rw@local", "-c", "user.name=rw", "commit", "-qam", `ablate ${req.kind} ${req.file}`], { cwd: wt });
      ablatedSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: wt })).stdout.trim();
    } catch (err) {
      return done(db, runId, {
        routeId: req.routeId, ablation, verdict: "ABLATION-INVALID", detail: `commit: ${String(err).slice(0, 160)}`, changedAfter: null,
      });
    }
    // Route-covering scenarios only: the verdict is about this route's diff.
    let scenarios;
    try {
      scenarios = loadScenarios(inputs.scenariosDir).filter((s) => s.routeIds.includes(req.routeId));
    } catch (err) {
      return done(db, runId, {
        routeId: req.routeId, ablation, verdict: "ABLATION-INVALID", detail: `scenarios: ${String(err).slice(0, 160)}`, changedAfter: null,
      });
    }
    if (scenarios.length === 0) {
      return done(db, runId, { routeId: req.routeId, ablation, verdict: "NO-ABLATION", detail: "no scenarios cover this route", changedAfter: null });
    }
    const subDir = join(root, "scenarios");
    mkdirSync(subDir, { recursive: true });
    scenarios.forEach((s, i) => writeFileSync(join(subDir, `s${i}.json`), JSON.stringify(s)));
    const replay = await runReplay({
      repoPath: inputs.repoPath,
      baseRef: inputs.baseRef,
      headRef: ablatedSha,
      scenariosDir: subDir,
      seedDbRel: inputs.seedDbRel ?? "seed/seed.db",
      ...(inputs.appDir ? { appDir: inputs.appDir } : {}),
      ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
      ...(inputs.language ? { language: inputs.language } : {}),
      workRoot: join(root, "replay"),
    });
    if (!replay.ok) {
      return done(db, runId, {
        routeId: req.routeId, ablation, verdict: "ABLATION-INVALID",
        detail: `replay ${replay.error.stage}: ${replay.error.message.slice(0, 160)}`, changedAfter: null,
      });
    }
    const masks = getArtifact<{ masks: string[] }>(db, runId, "learnedMasks")?.masks ?? [];
    const routes = new Map(scenarios.map((s) => [s.id, s.routeIds]));
    const stepDiffs = replay.base.steps.map((s, i) =>
      diffSteps(s, replay.head.steps[i] as (typeof replay.head.steps)[number], { mask: masks }),
    );
    const rd = aggregateByRoute(stepDiffs, routes).find((r) => r.routeId === req.routeId);
    const changedAfter = rd?.changed ?? false;
    return done(db, runId, {
      routeId: req.routeId,
      ablation,
      verdict: verdictAblation(true, changedAfter),
      detail: changedAfter ? "diff persists without the coupling" : "diff disappears without the coupling",
      changedAfter,
    });
  } finally {
    await removeWorktree(inputs.repoPath, wt).catch(() => {});
  }
}

/** Plan candidates for a route from its impact path + changed files. Never throws. */
export async function planForRoute(
  inputs: Pick<AblateInputs, "repoPath" | "baseRef" | "headRef" | "appDir">,
  workRoot: string,
  pathFiles: string[],
): Promise<AblationCandidate[]> {
  const { stdout } = await exec("git", ["diff", "--name-only", inputs.baseRef, inputs.headRef], { cwd: inputs.repoPath });
  const changedFiles = stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const wt = join(workRoot, `ablate-plan-${Date.now()}`);
  try {
    await createWorktree(inputs.repoPath, inputs.headRef, wt);
  } catch {
    return [];
  }
  try {
    const subs: { file: string; event: string }[] = [];
    for (const f of changedFiles) {
      if (!/\.[mc]?[jt]sx?$|\.py$/.test(f)) continue;
      let text: string;
      try {
        text = readFileSync(join(wt, f), "utf8");
      } catch {
        continue;
      }
      for (const s of findSubscriptions(text)) subs.push({ file: f, event: s.event });
    }
    return planAblations(changedFiles, pathFiles, subs);
  } finally {
    await removeWorktree(inputs.repoPath, wt).catch(() => {});
  }
}

async function applyEdit(
  inputs: AblateInputs,
  wt: string,
  req: AblateRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const abs = join(wt, req.file);
  if (req.kind === "pin_file") {
    try {
      const { stdout } = await exec("git", ["show", `${inputs.baseRef}:${req.file}`], { cwd: inputs.repoPath, maxBuffer: 8 * 1024 * 1024 });
      writeFileSync(abs, stdout);
      return { ok: true };
    } catch {
      return { ok: false, error: `file not present at base: ${req.file}` };
    }
  }
  if (!req.event) return { ok: false, error: "drop_event requires an event name" };
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return { ok: false, error: `cannot read ${req.file}` };
  }
  const dropped = dropEvent(text, req.event);
  if (!dropped.ok) return dropped;
  writeFileSync(abs, dropped.text);
  return { ok: true };
}

function done(db: Database.Database, runId: string, result: AblateResult): AblateResult {
  const log = getArtifact<AblateResult[]>(db, runId, "ablations") ?? [];
  putArtifact(db, runId, "ablations", [...log, result].slice(-20));
  return result;
}
