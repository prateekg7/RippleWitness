import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { fuseRoutes, scoreGate } from "@ripplewitness/core";
import type { ClaimEvidence, FusedNode, GateScore, RouteEvidence } from "@ripplewitness/core";
import { aggregateByRoute, diffSteps, resolveStepRoutes, runReplay } from "@ripplewitness/replay";
import type { RouteDiff } from "@ripplewitness/replay";
import { getArtifact, putArtifact } from "./store.js";

export interface AdoptCandidate {
  id: string;
  group: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  source: string;
}

export interface AdoptInputs {
  repoPath: string;
  baseRef: string;
  headRef: string;
  seedDbRel: string;
  appDir?: string;
  appStart?: string[];
  language?: "node" | "python" | "go";
}

interface StoredClaim {
  claimId: string;
  type: string;
  verdict: string;
  routes: string[];
}

/**
 * Shared execution gate for proposed scenarios (F-15/F-19/F-24): a candidate
 * is kept only if it replays deterministically (base-vs-base identical).
 * Kept scenarios merge into the run's route diffs; the run re-fuses and
 * re-scores over the enlarged set with provenance recorded. Generation
 * proposes, execution disposes.
 */
export async function verifyAndAdopt(
  db: Database.Database,
  runId: string,
  inputs: AdoptInputs,
  workRoot: string,
  candidates: AdoptCandidate[],
  gate: { minRecall: number; minPrecision: number },
): Promise<{
  kept: string[];
  dropped: { id: string; reason: string }[];
  routeDiffs: RouteDiff[];
  score: GateScore;
}> {
  const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
  const knownRoutes = fused.map((n) => n.routeId);
  const dir = mkdtempSync(join(tmpdir(), "rw-adopt-"));
  for (const c of candidates) {
    const routeIds = resolveStepRoutes(c.method, c.path, knownRoutes);
    writeFileSync(
      join(dir, `${c.id}.json`),
      JSON.stringify({
        id: c.id,
        group: c.group,
        routeIds,
        steps: [{ method: c.method, path: c.path, headers: c.headers, ...(c.body === null || c.body === undefined ? {} : { body: c.body }) }],
      }),
    );
  }
  const replayOpts = {
    repoPath: inputs.repoPath,
    baseRef: inputs.baseRef,
    headRef: inputs.baseRef,
    scenariosDir: dir,
    seedDbRel: inputs.seedDbRel,
    ...(inputs.appDir ? { appDir: inputs.appDir } : {}),
    ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
    ...(inputs.language ? { language: inputs.language } : {}),
  };
  const detour = await runReplay({ ...replayOpts, workRoot: `${workRoot}/adopt-det-${runId}` });
  if (!detour.ok) {
    return {
      kept: [],
      dropped: candidates.map((c) => ({ id: c.id, reason: `determinism replay failed: ${detour.error.stage}` })),
      routeDiffs: getArtifact<RouteDiff[]>(db, runId, "routeDiffs") ?? [],
      score: JSON.parse((db.prepare("SELECT score FROM runs WHERE id = ?").get(runId) as { score: string }).score) as GateScore,
    };
  }
  // Determinism: base-vs-base must be identical per scenario (CT-HRV-02).
  const nonDeterministic = new Set<string>();
  detour.base.steps.forEach((s, i) => {
    const h = detour.head.steps[i] as (typeof detour.head.steps)[number];
    if (diffSteps(s, h).changed) nonDeterministic.add(s.scenarioId);
  });
  const kept = candidates.map((c) => c.id).filter((id) => !nonDeterministic.has(id));
  const dropped = candidates
    .map((c) => c.id)
    .filter((id) => nonDeterministic.has(id))
    .map((id) => ({ id, reason: "non-deterministic on base double-run" }));
  if (kept.length === 0) {
    putArtifact(db, runId, "adoptedScenarios", { kept: [], dropped, at: new Date().toISOString() });
    return {
      kept: [],
      dropped,
      routeDiffs: getArtifact<RouteDiff[]>(db, runId, "routeDiffs") ?? [],
      score: JSON.parse((db.prepare("SELECT score FROM runs WHERE id = ?").get(runId) as { score: string }).score) as GateScore,
    };
  }
  const change = await runReplay({ ...replayOpts, headRef: inputs.headRef, workRoot: `${workRoot}/adopt-chg-${runId}` });
  if (!change.ok) {
    return {
      kept: [],
      dropped: kept.map((id) => ({ id, reason: `change replay failed: ${change.error.stage}` })),
      routeDiffs: getArtifact<RouteDiff[]>(db, runId, "routeDiffs") ?? [],
      score: JSON.parse((db.prepare("SELECT score FROM runs WHERE id = ?").get(runId) as { score: string }).score) as GateScore,
    };
  }
  const scenarioRoutes = new Map(
    candidates.filter((c) => kept.includes(c.id)).map((c) => [c.id, resolveStepRoutes(c.method, c.path, knownRoutes)] as [string, string[]]),
  );
  const stepDiffs = change.base.steps
    .filter((s) => kept.includes(s.scenarioId))
    .map((s) => {
      const h = change.head.steps.find((x) => x.scenarioId === s.scenarioId && x.stepIndex === s.stepIndex) as
        | (typeof change.head.steps)[number]
        | undefined;
      if (!h) return null;
      return diffSteps(s, h);
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const fresh = aggregateByRoute(stepDiffs, scenarioRoutes);
  // Merge into the run's existing route diffs.
  const merged = new Map<string, RouteDiff>();
  for (const r of getArtifact<RouteDiff[]>(db, runId, "routeDiffs") ?? []) merged.set(r.routeId, r);
  for (const r of fresh) {
    const prev = merged.get(r.routeId);
    if (!prev) {
      merged.set(r.routeId, r);
    } else {
      merged.set(r.routeId, {
        routeId: r.routeId,
        scenarioIds: [...new Set([...prev.scenarioIds, ...r.scenarioIds])].sort(),
        changed: prev.changed || r.changed,
        kinds: [...new Set([...prev.kinds, ...r.kinds])].sort(),
        diffs: [...prev.diffs, ...r.diffs],
        tolerated: [...(prev.tolerated ?? []), ...(r.tolerated ?? [])],
      });
    }
  }
  const routeDiffs = [...merged.values()].sort((a, b) => (a.routeId < b.routeId ? -1 : 1));
  putArtifact(db, runId, "routeDiffs", routeDiffs);
  // Re-fuse over the enlarged set, preserving static claims and claim verdicts.
  const oldById = new Map(fused.map((n) => [n.routeId, n]));
  const reviewMode = getArtifact<string>(db, runId, "reviewMode") ?? "full";
  const evidence: RouteEvidence[] = routeDiffs.map((r) => ({
    routeId: r.routeId,
    exercised: true,
    observedChanged: r.changed,
    staticImpacted: oldById.get(r.routeId)?.staticImpacted ?? false,
    inDiff: oldById.get(r.routeId)?.inDiff ?? false,
    isNew: false,
  }));
  const stored = getArtifact<StoredClaim[]>(db, runId, "claims") ?? [];
  const claimEvidence: ClaimEvidence[] = stored.map((s) => ({
    claimId: s.claimId,
    type: s.type as ClaimEvidence["type"],
    verdict: s.verdict as ClaimEvidence["verdict"],
    routes: s.routes,
  }));
  putArtifact(db, runId, "fused", fuseRoutes(evidence, claimEvidence, reviewMode === "dynamic-only" ? { staticUnknown: true } : {}));
  // Re-score the locked prediction over the enlarged set (PRD US-11).
  const run = db.prepare("SELECT prediction, score FROM runs WHERE id = ?").get(runId) as { prediction: string; score: string };
  const prevScore = JSON.parse(run.score) as GateScore;
  const score = scoreGate(JSON.parse(run.prediction), evidence, gate);
  db.prepare("UPDATE runs SET score = ? WHERE id = ?").run(JSON.stringify(score), runId);
  const log = getArtifact<{ entries: unknown[] }>(db, runId, "rescoreLog") ?? { entries: [] };
  log.entries.push({ at: new Date().toISOString(), addedScenarios: kept, prevScore, newScore: score });
  putArtifact(db, runId, "rescoreLog", log);
  putArtifact(db, runId, "adoptedScenarios", {
    kept: candidates.filter((c) => kept.includes(c.id)),
    dropped,
    at: new Date().toISOString(),
  });
  return { kept, dropped, routeDiffs, score };
}
