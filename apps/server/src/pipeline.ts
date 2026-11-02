import { randomUUID } from "node:crypto";
import { execa } from "execa";
import type Database from "better-sqlite3";
import { computeImpact } from "@ripplewitness/graph";
import type { ChangedFile } from "@ripplewitness/graph";
import { extractStaticGraph } from "@ripplewitness/graph";
import { aggregateByRoute, detectVolatile, diffSteps, loadScenarios, runReplay } from "@ripplewitness/replay";
import { fuseRoutes } from "@ripplewitness/core";
import type { ClaimEvidence, FusedNode, RouteEvidence } from "@ripplewitness/core";
import { buildQuestions } from "@ripplewitness/crossexam";
import { putArtifact } from "./store.js";

export interface AnalyzeInput {
  repoPath: string;
  baseRef: string;
  headRef: string;
  scenariosDir: string;
  appDir?: string;
  seedDbRel?: string;
  flakeGuard?: boolean;
}

export type StageState = "ok" | "degraded" | "failed" | "pending";

function parseDiffAddedLines(diff: string, prefix: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  let file = "";
  let nl = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const full = line.slice("+++ b/".length);
      file = full.startsWith(prefix) ? full.slice(prefix.length) : "";
      if (file) out.push({ file, lines: [] });
    } else if (line.startsWith("@@ ")) {
      nl = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) {
      out[out.length - 1]?.lines.push(nl);
      nl += 1;
    } else if (file && !line.startsWith("-") && nl > 0) {
      nl += 1;
    }
  }
  return out.filter((f) => f.lines.length > 0);
}

/** Run the full deterministic pipeline. Returns runId; artifacts in store. Never throws. */
export async function runAnalysis(
  db: Database.Database,
  workRoot: string,
  input: AnalyzeInput,
  runId: string = randomUUID(),
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const stages: Record<string, StageState> = {
    graph: "pending",
    replay: "pending",
    fusion: "pending",
    claims: "pending",
    questions: "pending",
  };
  const setStages = (): void => {
    db.prepare("UPDATE runs SET stages = ? WHERE id = ?").run(JSON.stringify(stages), runId);
  };
  db.prepare(
    "INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, input.repoPath, input.baseRef, input.headRef, "running", JSON.stringify(stages), new Date().toISOString());
  putArtifact(db, runId, "inputs", {
    repoPath: input.repoPath,
    baseRef: input.baseRef,
    headRef: input.headRef,
    scenariosDir: input.scenariosDir,
    ...(input.appDir ? { appDir: input.appDir } : {}),
    ...(input.seedDbRel ? { seedDbRel: input.seedDbRel } : {}),
  });

  try {
    // Stage graph: diff + head-tree extraction + impact.
    let impact: ReturnType<typeof computeImpact> | null = null;
    let graph: ReturnType<typeof extractStaticGraph> | null = null;
    try {
      const { stdout } = await execa("git", ["diff", "--unified=0", input.baseRef, input.headRef], {
        cwd: input.repoPath,
      });
      const appPrefix = input.appDir && input.appDir !== "." ? `${input.appDir.replace(/\/$/, "")}/` : "";
      // Extract from a worktree of head so line numbers match the diff.
      const { createWorktree, removeWorktree } = await import("@ripplewitness/replay");
      const wt = `${workRoot}/wt-graph-${runId}`;
      await createWorktree(input.repoPath, input.headRef, wt);
      try {
        const appRoot = appPrefix ? `${wt}/${input.appDir}` : wt;
        graph = extractStaticGraph(appRoot);
        impact = computeImpact(graph, parseDiffAddedLines(stdout, appPrefix));
      } finally {
        await removeWorktree(input.repoPath, wt).catch(() => {});
      }
      stages.graph = "ok";
    } catch (err) {
      stages.graph = "failed";
      putArtifact(db, runId, "graph-error", { message: String(err) });
    }
    setStages();

    // Stage replay (+ optional base double-run flake guard).
    const replay = await runReplay({
      repoPath: input.repoPath,
      baseRef: input.baseRef,
      headRef: input.headRef,
      scenariosDir: input.scenariosDir,
      seedDbRel: input.seedDbRel ?? "seed/seed.db",
      ...(input.appDir ? { appDir: input.appDir } : {}),
      workRoot: `${workRoot}/runs/${runId}`,
    });
    if (!replay.ok) {
      stages.replay = "failed";
      setStages();
      db.prepare("UPDATE runs SET status = ? WHERE id = ?").run("static-only", runId);
      putArtifact(db, runId, "fused", []);
      putArtifact(db, runId, "static-impact", impact?.staticImpacted ?? []);
      putArtifact(db, runId, "claims", []);
      putArtifact(db, runId, "questions", []);
      return { ok: true, runId };
    }
    stages.replay = "ok";
    setStages();

    // Diff + flake guard.
    const scenarios = loadScenarios(input.scenariosDir);
    const scenarioRoutes = new Map(scenarios.map((s) => [s.id, s.routeIds]));
    let volatileRoutes: string[] = [];
    if (input.flakeGuard !== false) {
      const rerun = await runReplay({
        repoPath: input.repoPath,
        baseRef: input.baseRef,
        headRef: input.baseRef,
        scenariosDir: input.scenariosDir,
        seedDbRel: input.seedDbRel ?? "seed/seed.db",
        ...(input.appDir ? { appDir: input.appDir } : {}),
        workRoot: `${workRoot}/runs/${runId}-flake`,
      });
      if (rerun.ok) {
        volatileRoutes = detectVolatile(replay.base.steps, rerun.base.steps, scenarioRoutes).volatileRoutes;
      }
    }
    const stepDiffs = replay.base.steps.map((s, i) =>
      diffSteps(s, replay.head.steps[i] as (typeof replay.head.steps)[number]),
    );
    const routeDiffs = aggregateByRoute(stepDiffs, scenarioRoutes);

    // Stage fusion.
    const routeIds = new Set<string>([
      ...routeDiffs.map((r) => r.routeId),
      ...(impact?.staticImpacted.filter((id) => id.startsWith("route:")) ?? []),
    ]);
    const staticSet = new Set(impact?.staticImpacted ?? []);
    const evidence: RouteEvidence[] = [...routeIds].sort().map((routeId) => {
      const rd = routeDiffs.find((r) => r.routeId === routeId);
      return {
        routeId,
        exercised: rd !== undefined,
        observedChanged: rd?.changed ?? false,
        staticImpacted: staticSet.has(routeId),
        inDiff: false,
        isNew: false,
      };
    });
    // New routes: in head graph but exercised only on head (404 on base).
    const claims: ClaimEvidence[] = [];
    const fused: FusedNode[] = fuseRoutes(evidence, claims);
    putArtifact(db, runId, "fused", fused);
    putArtifact(db, runId, "routeDiffs", routeDiffs);
    putArtifact(db, runId, "volatileRoutes", volatileRoutes);
    putArtifact(db, runId, "impactPaths", impact?.paths ?? {});
    putArtifact(db, runId, "claims", []);
    putArtifact(db, runId, "headSymbols", [
      ...(graph?.nodes.filter((n) => n.kind === "route").map((n) => n.id) ?? []),
      ...(graph?.nodes.filter((n) => n.kind === "service" || n.kind === "handler").map((n) => n.label) ?? []),
    ]);
    const built = buildQuestions({
      fused,
      claimResults: [],
      routeDiffSummary: new Map(
        routeDiffs.map((r) => [r.routeId, r.diffs.slice(0, 3).map((d) => `${d.path}: ${JSON.stringify(d.before)}→${JSON.stringify(d.after)}`).join("; ")]),
      ),
    });
    const insQ = db.prepare(
      "INSERT INTO questions (id, runId, template, routeId, claimId, status, askedCount, need) VALUES (?, ?, ?, ?, ?, 'OPEN', 0, ?)",
    );
    for (const q of built) {
      insQ.run(randomUUID(), runId, q.template, q.routeId, q.claimId, q.need);
    }
    putArtifact(db, runId, "questionTexts", Object.fromEntries(built.map((q) => [`${q.template}:${q.routeId ?? ""}:${q.claimId ?? ""}`, { text: q.text, anchors: q.anchors }])));
    stages.fusion = "ok";
    stages.claims = "degraded"; // extractor wires in RW-14; degraded until then
    stages.questions = "ok"; // templates wire in RW-16; empty set is valid
    setStages();
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run("ready", runId);
    return { ok: true, runId };
  } catch (err) {
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run("failed", runId);
    putArtifact(db, runId, "fatal", { message: String(err) });
    return { ok: false, error: String(err) };
  }
}
