import { randomUUID } from "node:crypto";
import { execa } from "execa";
import type Database from "better-sqlite3";
import { computeImpact, detectLanguage } from "@ripplewitness/graph";
import type { ChangedFile } from "@ripplewitness/graph";
import { extractStaticGraph } from "@ripplewitness/graph";
import { aggregateByRoute, detectVolatile, diffSteps, learnMasks, loadScenarios, runReplay } from "@ripplewitness/replay";
import { fuseRoutes, inheritStaticImpact, routePatternMatches } from "@ripplewitness/core";
import type { ClaimEvidence, FusedNode, RouteEvidence } from "@ripplewitness/core";
import { buildQuestions } from "@ripplewitness/crossexam";
import { createLogger } from "./log.js";
import { getArtifact, putArtifact } from "./store.js";

export interface AnalyzeInput {
  repoPath: string;
  baseRef: string;
  headRef: string;
  scenariosDir: string;
  appDir?: string;
  seedDbRel?: string;
  flakeGuard?: boolean;
  /** Explicit subject language; wins over detection (TRD §7.2). */
  language?: "node" | "python" | "go";
  /** Start command argv override; wins over `package.json` discovery. */
  appStart?: string[];
  /** Repo-relative artifact paths (model weights, datasets) to hash (F-25). */
  artifacts?: string[];
  /** Precomputed static graph (M-11); skips the built-in extractor when present. */
  externalGraph?: import("@ripplewitness/graph").StaticGraph;
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
  const log = createLogger(runId);
  const setStages = (): void => {
    db.prepare("UPDATE runs SET stages = ? WHERE id = ?").run(JSON.stringify(stages), runId);
  };
  db.prepare(
    "INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, input.repoPath, input.baseRef, input.headRef, "running", JSON.stringify(stages), new Date().toISOString());
  log.info("analysis_started", { baseRef: input.baseRef, headRef: input.headRef, language: input.language ?? "auto" });
  putArtifact(db, runId, "inputs", {
    repoPath: input.repoPath,
    baseRef: input.baseRef,
    headRef: input.headRef,
    scenariosDir: input.scenariosDir,
    ...(input.appDir ? { appDir: input.appDir } : {}),
    ...(input.seedDbRel ? { seedDbRel: input.seedDbRel } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.appStart ? { appStart: input.appStart } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
  });

  try {
    // Stage graph: diff + head-tree extraction + impact.
    let impact: ReturnType<typeof computeImpact> | null = null;
    let graph: ReturnType<typeof extractStaticGraph> | null = null;
    let dynamicOnly = false;
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
        const detected = detectLanguage(appRoot);
        const language = input.language ?? (detected === "unknown" ? "node" : detected);
        putArtifact(db, runId, "language", { explicit: input.language ?? null, detected, effective: language });
        const { describeSandbox } = await import("@ripplewitness/replay");
        putArtifact(db, runId, "runEnv", {
          language,
          interposition:
            language === "python"
              ? ["PYTHONHASHSEED=0", "sitecustomize time/seed freeze", "CUDA_VISIBLE_DEVICES= (CPU-only)"]
              : language === "go"
                ? ["none available — avoid wall-clock/map-order nondeterminism"]
                : ["NODE_OPTIONS freeze preload (Date.now/Math.random)"],
          frozenTime: "2026-01-01T00:00:00Z",
          seed: "42",
          sandbox: describeSandbox(),
        });
        if (input.externalGraph) {
          graph = input.externalGraph;
          putArtifact(db, runId, "graphSource", "external");
        } else {
          putArtifact(db, runId, "graphSource", language);
          const extractFor = async (root: string): Promise<ReturnType<typeof extractStaticGraph>> => {
            if (language === "python") {
              const { extractPythonGraph } = await import("@ripplewitness/graph");
              return extractPythonGraph(root);
            }
            if (language === "go") {
              const { extractGoGraph } = await import("@ripplewitness/graph");
              return extractGoGraph(root);
            }
            return extractStaticGraph(root);
          };
          graph = await extractFor(appRoot);
          // Base routes distinguish DIFF (added in head) from CONFIRMED.
          // Best-effort: a failed base pass degrades to isNew=false.
          const baseWt = `${workRoot}/wt-graph-base-${runId}`;
          try {
            await createWorktree(input.repoPath, input.baseRef, baseWt);
            const baseGraph = await extractFor(appPrefix ? `${baseWt}/${input.appDir}` : baseWt);
            putArtifact(
              db,
              runId,
              "baseRoutes",
              baseGraph.nodes.filter((n) => n.kind === "route").map((n) => n.id),
            );
          } catch {
            putArtifact(db, runId, "baseRoutes", null);
          } finally {
            await removeWorktree(input.repoPath, baseWt).catch(() => {});
          }
        }
        putArtifact(db, runId, "graph", graph); // F-16 maps impact paths back to files
        const routeCount = graph.nodes.filter((n) => n.kind === "route").length;
        // J-05, generalized: a static pass that finds zero routes in ANY
        // language is not a failure — the review runs dynamic-only
        // (inventory from scenarios + __routes), with no SURPRISE labels.
        dynamicOnly = routeCount === 0;
        putArtifact(db, runId, "reviewMode", dynamicOnly ? "dynamic-only" : "full");
        const { hashArtifactFiles, tierForReviewMode } = await import("./receipts.js");
        putArtifact(db, runId, "assuranceTier", tierForReviewMode(dynamicOnly ? "dynamic-only" : "full"));
        if (input.artifacts && input.artifacts.length > 0) {
          putArtifact(db, runId, "artifactHashes", hashArtifactFiles(appRoot, input.artifacts));
        }
        impact = dynamicOnly ? null : computeImpact(graph, parseDiffAddedLines(stdout, appPrefix));
      } finally {
        await removeWorktree(input.repoPath, wt).catch(() => {});
      }
      stages.graph = "ok";
      log.info("stage_graph", { state: "ok", dynamicOnly });
    } catch (err) {
      stages.graph = "failed";
      putArtifact(db, runId, "graph-error", { message: String(err) });
      log.warn("stage_graph", { state: "failed", message: String(err).slice(0, 200) });
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
      ...(input.appStart ? { appStart: input.appStart } : {}),
      ...(input.language ? { language: input.language } : {}),
      workRoot: `${workRoot}/runs/${runId}`,
    });
    if (!replay.ok) {
      stages.replay = "failed";
      log.warn("stage_replay", { state: "failed", fallback: "static-only" });
      setStages();
      putArtifact(db, runId, "reviewMode", "static-only");
      putArtifact(db, runId, "assuranceTier", "L0");
      db.prepare("UPDATE runs SET status = ? WHERE id = ?").run("static-only", runId);
      putArtifact(db, runId, "fused", []);
      putArtifact(db, runId, "static-impact", impact?.staticImpacted ?? []);
      putArtifact(db, runId, "claims", []);
      putArtifact(db, runId, "questions", []);
      return { ok: true, runId };
    }
    stages.replay = "ok";
    setStages();

    // Diff + flake guard + auto-mask learning.
    const scenarios = loadScenarios(input.scenariosDir);
    const scenarioRoutes = new Map(scenarios.map((s) => [s.id, s.routeIds]));
    let volatileRoutes: string[] = [];
    let learnedMasks: string[] = [];
    if (input.flakeGuard !== false) {
      const rerun = await runReplay({
        repoPath: input.repoPath,
        baseRef: input.baseRef,
        headRef: input.baseRef,
        scenariosDir: input.scenariosDir,
        seedDbRel: input.seedDbRel ?? "seed/seed.db",
        ...(input.appDir ? { appDir: input.appDir } : {}),
        ...(input.appStart ? { appStart: input.appStart } : {}),
        ...(input.language ? { language: input.language } : {}),
        workRoot: `${workRoot}/runs/${runId}-flake`,
      });
      if (rerun.ok) {
        // One learn→mask→recheck pass per base run-pair (F-22): fields that
        // wobble between identical base runs are masked, not verdicts; what
        // still differs afterwards is genuinely volatile.
        learnedMasks = learnMasks(replay.base.steps, rerun.base.steps);
        putArtifact(db, runId, "learnedMasks", { masks: learnedMasks, iterations: 1 });
        volatileRoutes = detectVolatile(replay.base.steps, rerun.base.steps, scenarioRoutes, {
          mask: learnedMasks,
        }).volatileRoutes;
      }
    }
    const tolerancesByScenario = new Map(scenarios.map((s) => [s.id, s.tolerances ?? []]));
    const stepDiffs = replay.base.steps.map((s, i) =>
      diffSteps(s, replay.head.steps[i] as (typeof replay.head.steps)[number], {
        mask: learnedMasks,
        tolerances: tolerancesByScenario.get(s.scenarioId) ?? [],
      }),
    );
    const routeDiffs = aggregateByRoute(stepDiffs, scenarioRoutes);

    // Stage fusion.
    const allRouteIds = new Set<string>([
      ...routeDiffs.map((r) => r.routeId),
      ...(impact?.staticImpacted.filter((id) => id.startsWith("route:")) ?? []),
      ...replay.base.routes,
      ...replay.head.routes,
    ]);
    // A static pattern (GET /:name) that an exercised concrete route already
    // represents must not surface as its own node; the concrete route
    // inherits its impact below. Unexercised patterns stay (UNVERIFIED).
    const exercisedIds = routeDiffs.map((r) => r.routeId);
    const routeIds = [...allRouteIds].filter(
      (id) =>
        exercisedIds.includes(id) || !exercisedIds.some((ex) => routePatternMatches(id, ex)),
    );
    const headRouteSet = new Set((graph?.nodes ?? []).filter((n) => n.kind === "route").map((n) => n.id));
    const baseRoutes = getArtifact<string[] | null>(db, runId, "baseRoutes");
    const baseRouteSet = baseRoutes ? new Set(baseRoutes) : null;
    const impactSets = {
      staticImpacted: impact?.staticImpacted ?? [],
      inDiff: impact?.inDiff ?? [],
      paths: impact?.paths ?? {},
    };
    const evidence: RouteEvidence[] = [...routeIds].sort().map((routeId) => {
      const rd = routeDiffs.find((r) => r.routeId === routeId);
      const inherited = inheritStaticImpact(routeId, impactSets);
      return {
        routeId,
        exercised: rd !== undefined,
        observedChanged: rd?.changed ?? false,
        staticImpacted: inherited.staticImpacted,
        inDiff: inherited.inDiff,
        // New route: present in the head graph, absent from the base graph.
        isNew: baseRouteSet !== null && headRouteSet.has(routeId) && !baseRouteSet.has(routeId),
        impactPath: inherited.impactPath,
      };
    });
    const claims: ClaimEvidence[] = [];
    const fused: FusedNode[] = fuseRoutes(evidence, claims, dynamicOnly ? { staticUnknown: true } : {});
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
    stages.claims = "degraded"; // extraction happens via POST agent-message after the agent summary arrives
    stages.questions = "ok";
    setStages();
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run("ready", runId);
    log.info("analysis_ready", { fused: fused.length, questions: built.length });
    return { ok: true, runId };
  } catch (err) {
    db.prepare("UPDATE runs SET status = ? WHERE id = ?").run("failed", runId);
    putArtifact(db, runId, "fatal", { message: String(err) });
    log.error("analysis_failed", { message: String(err).slice(0, 200) });
    return { ok: false, error: String(err) };
  }
}
