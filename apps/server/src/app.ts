import { randomUUID } from "node:crypto";
import express from "express";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { DEFAULT_GATE, fuseRoutes, scoreGate } from "@ripplewitness/core";
import type { ClaimEvidence, ClaimType, FusedNode, RouteEvidence } from "@ripplewitness/core";
import { assessAnswer, buildQuestions, quotaAllows, rephrasePassthrough, verifyAll } from "@ripplewitness/crossexam";
import type { VerifyClaim } from "@ripplewitness/crossexam";
import type { AgentSessionPort, ExplainerInput, ExtractedClaim, SummaryInput } from "@ripplewitness/agents";
import {
  FindingSchema,
  MockSession,
  metaClientForRun,
  parseDiffHunks,
  validateExplanation,
  validateFindings,
  validateSummary,
} from "@ripplewitness/agents";
import { ExternalGraphSchema, parseExternalGraph } from "@ripplewitness/graph";
import { getArtifact, putArtifact } from "./store.js";
import { getCalibration, hashReviewer, recordCalibration } from "./calibration.js";
import { runAnalysis } from "./pipeline.js";
import type { AnalyzeInput } from "./pipeline.js";
import { issueReceipt } from "./receipts.js";
import { trailerValue } from "@ripplewitness/receipt";

const GateSchema = z.object({ minRecall: z.number().min(0).max(1), minPrecision: z.number().min(0).max(1) });
const AnalyzeSchema = z.object({
  repoPath: z.string().min(1),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  scenariosDir: z.string().min(1),
  appDir: z.string().optional(),
  seedDbRel: z.string().optional(),
  flakeGuard: z.boolean().optional(),
  gate: GateSchema.optional(),
  language: z.enum(["node", "python", "go"]).optional(),
  appStart: z.array(z.string().min(1)).max(16).optional(),
  artifacts: z.array(z.string().min(1)).max(16).optional(),
  /** Precomputed static graph (M-11); skips the built-in extractor. */
  externalGraph: ExternalGraphSchema.optional(),
});
const PredictSchema = z.object({
  routeIds: z.array(z.string()).max(200),
  nothingElse: z.boolean(),
  reviewer: z.string().min(1).max(64).optional(),
});

/** Canonical prediction shape for relock comparison (IT-API-01). */
function canonicalPrediction(p: unknown): { routeIds: string[]; nothingElse: boolean } {
  const parsed = z.object({ routeIds: z.array(z.string()), nothingElse: z.boolean() }).safeParse(p);
  if (!parsed.success) return { routeIds: [], nothingElse: false };
  return { routeIds: [...parsed.data.routeIds].sort(), nothingElse: parsed.data.nothingElse };
}
const OverrideSchema = z.object({ reason: z.string().min(1).max(500) });

export interface LockedRunConfig {
  repoPath: string;
  baseRef: string;
  headRef: string;
  scenariosDir: string;
  seedDbRel?: string;
  appStart?: string[];
  appDir?: string;
  language?: "node" | "python" | "go";
}

export interface ServerOptions {
  workRoot: string;
  home: string;
  /** Hosted-demo lock: forces these subject fields on every analyze; client-supplied values are ignored. */
  lockedRun?: LockedRunConfig;
  gate?: { minRecall: number; minPrecision: number };
  session?: AgentSessionPort;
  /** Claim extraction hook (LLM in prod, stub in tests). Absent => 503 no_llm. */
  extractor?: (text: string, knownRoutes: string[], runId: string) => Promise<ExtractedClaim[]>;
  /** Question phrasing hook (LLM in prod). Absent => raw templates. Never 503s. */
  phraser?: (raw: string, runId: string) => Promise<string>;
  /** Canary planner hook (LLM in prod). Absent => deterministic proposer. */
  planner?: (hunks: { file: string; startLine: number; text: string }[], runId: string) => Promise<{ file: string; line: number; operator: string; rationale: string } | null>;
  /** F-14 agent defaults from ripplewitness.config.yaml. */
  agentDefaults?: { explainerMaxSentences?: number; summaryStyle?: string };
  reviewer?: (diff: string, runId: string) => Promise<unknown>;
  explainer?: (input: ExplainerInput, runId: string) => Promise<unknown>;
  summarizer?: (input: SummaryInput, runId: string) => Promise<unknown>;
}

interface StoredClaim extends ClaimEvidence {
  text: string;
}

function verifierEvidence(db: Database.Database, runId: string): {
  observedChanged: Set<string>;
  exercised: Set<string>;
  headSymbols: Set<string>;
  fieldDiffs: Map<string, { path: string; before: unknown; after: unknown }[]>;
} {
  const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
  const routeDiffs =
    getArtifact<{ routeId: string; diffs: { path: string; before: unknown; after: unknown }[] }[]>(db, runId, "routeDiffs") ?? [];
  const headSymbols = new Set(getArtifact<string[]>(db, runId, "headSymbols") ?? []);
  return {
    observedChanged: new Set(fused.filter((n) => n.exercised && n.observedChanged).map((n) => n.routeId)),
    exercised: new Set(fused.filter((n) => n.exercised).map((n) => n.routeId)),
    headSymbols,
    fieldDiffs: new Map(routeDiffs.map((r) => [r.routeId, r.diffs])),
  };
}

/** Hosted-demo abuse limits (locked mode only; local use is unlimited). */
export const HOSTED_API_PER_5MIN = 600;
export const HOSTED_ANALYZE_PER_HOUR = 6;
export const HOSTED_MAX_CONCURRENT = 2;

function fixedWindow(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: () => void): void => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    const cur = hits.get(key);
    if (!cur || cur.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    cur.count += 1;
    if (cur.count > max) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}

export function createServer(db: Database.Database, opts: ServerOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const serverGate = opts.gate;
  let activeAnalyses = 0;
  if (opts.lockedRun) {
    // Behind the hosting proxy the client IP arrives via X-Forwarded-For.
    app.set("trust proxy", 1);
    app.use("/api", fixedWindow(5 * 60_000, HOSTED_API_PER_5MIN));
  }

  app.get("/api/health", (_req: Request, res: Response) => res.json({ ok: true }));

  app.get("/api/config", (_req: Request, res: Response) => res.json({ lockedRun: opts.lockedRun ?? null }));

  app.get("/api/runs", (_req: Request, res: Response) => {
    const rows = db.prepare("SELECT id, status, createdAt FROM runs ORDER BY createdAt DESC LIMIT 20").all();
    return res.json({ runs: rows });
  });

  const analyzeHourly = opts.lockedRun
    ? fixedWindow(60 * 60_000, HOSTED_ANALYZE_PER_HOUR)
    : (_req: Request, _res: Response, next: () => void): void => next();

  app.post("/api/analyze", analyzeHourly, (req: Request, res: Response) => {
    const parsed = AnalyzeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    // The schema checks shapes; integrity (dangling edges, duplicate ids) is checked here.
    const external = parsed.data.externalGraph ? parseExternalGraph(parsed.data.externalGraph) : null;
    if (external && !external.ok) return res.status(400).json({ error: "invalid_input" });
    const runId = randomUUID();
    if (parsed.data.gate) putArtifact(db, runId, "gate", parsed.data.gate);
    const locked = opts.lockedRun;
    const input: AnalyzeInput = {
      repoPath: locked?.repoPath ?? parsed.data.repoPath,
      baseRef: locked?.baseRef ?? parsed.data.baseRef,
      headRef: locked?.headRef ?? parsed.data.headRef,
      scenariosDir: locked?.scenariosDir ?? parsed.data.scenariosDir,
      ...(locked
        ? {
            ...(locked.appDir ? { appDir: locked.appDir } : {}),
            ...(locked.seedDbRel ? { seedDbRel: locked.seedDbRel } : {}),
            ...(locked.language ? { language: locked.language } : {}),
            ...(locked.appStart ? { appStart: locked.appStart } : {}),
          }
        : {
            ...(parsed.data.appDir ? { appDir: parsed.data.appDir } : {}),
            ...(parsed.data.seedDbRel ? { seedDbRel: parsed.data.seedDbRel } : {}),
            ...(parsed.data.language ? { language: parsed.data.language } : {}),
            ...(parsed.data.appStart ? { appStart: parsed.data.appStart } : {}),
            ...(parsed.data.artifacts ? { artifacts: parsed.data.artifacts } : {}),
          }),
      ...(parsed.data.flakeGuard === undefined ? {} : { flakeGuard: parsed.data.flakeGuard }),
      ...(external && external.ok && !locked ? { externalGraph: external.graph } : {}),
    };
    if (locked && activeAnalyses >= HOSTED_MAX_CONCURRENT) {
      return res.status(429).json({ error: "busy" });
    }
    if (locked) {
      activeAnalyses += 1;
      void runAnalysis(db, opts.workRoot, input, runId).finally(() => {
        activeAnalyses -= 1;
      });
    } else {
      void runAnalysis(db, opts.workRoot, input, runId);
    }
    return res.status(202).json({ runId });
  });

  app.get("/api/runs/:id/status", (req: Request, res: Response) => {
    const row = db.prepare("SELECT id, status, stages, locked FROM runs WHERE id = ?").get((req.params.id as string));
    if (!row) return res.status(404).json({ error: "not_found" });
    const reviewMode = getArtifact<string>(db, (req.params.id as string), "reviewMode") ?? "full";
    return res.json({ ...row, reviewMode });
  });

  // F-01 diff cockpit: the diff under review, visible before and after lock.
  app.get("/api/runs/:id/diff", async (req: Request, res: Response) => {
    const run = db.prepare("SELECT id FROM runs WHERE id = ?").get((req.params.id as string));
    if (!run) return res.status(404).json({ error: "not_found" });
    const inputs = getArtifact<{ repoPath: string; baseRef: string; headRef: string }>(db, (req.params.id as string), "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { execa } = await import("execa");
    let stdout: string;
    try {
      ({ stdout } = await execa("git", ["diff", inputs.baseRef, inputs.headRef], { cwd: inputs.repoPath, maxBuffer: 32 * 1024 * 1024 }));
    } catch {
      return res.status(409).json({ error: "diff_failed" });
    }
    const { parseUnifiedDiff } = await import("./diff.js");
    return res.json({ files: parseUnifiedDiff(stdout) });
  });

  // Pre-lock map: static shape only — no observed status (anti-anchoring).
  app.get("/api/runs/:id/map", (req: Request, res: Response) => {
    const run = db.prepare("SELECT id, locked FROM runs WHERE id = ?").get((req.params.id as string)) as
      | { id: string; locked: number }
      | undefined;
    if (!run) return res.status(404).json({ error: "not_found" });
    const fused = getArtifact<FusedNode[]>(db, run.id, "fused") ?? [];
    if (run.locked) return res.json({ nodes: fused });
    // F-17: personal checklist from past reviews only — never current observations.
    const reviewer = typeof req.query.reviewer === "string" ? req.query.reviewer : "local";
    const calibration = getCalibration(db, hashReviewer(reviewer));
    return res.json({
      nodes: fused.map((n) => ({
        routeId: n.routeId,
        staticImpacted: n.staticImpacted,
        inDiff: n.inDiff,
        exercised: n.exercised,
      })),
      calibration: calibration.checklist,
    });
  });

  app.post("/api/runs/:id/predict", (req: Request, res: Response) => {
    const run = db.prepare("SELECT id, locked, status FROM runs WHERE id = ?").get((req.params.id as string)) as
      | { id: string; locked: number; status: string }
      | undefined;
    if (!run) return res.status(404).json({ error: "not_found" });
    if (run.status !== "ready") return res.status(409).json({ error: `not_ready:${run.status}` });
    const parsed = PredictSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    // IT-API-01: identical relock is idempotent (double-click safe); anything else 409s.
    if (run.locked) {
      const prev = (db.prepare("SELECT prediction FROM runs WHERE id = ?").get(run.id) as { prediction: string }).prediction;
      const same =
        JSON.stringify({ routeIds: [...parsed.data.routeIds].sort(), nothingElse: parsed.data.nothingElse }) ===
        JSON.stringify(canonicalPrediction(JSON.parse(prev) as unknown));
      return same ? res.json({ locked: true, duplicate: true }) : res.status(409).json({ error: "already_locked" });
    }
    const fused = getArtifact<FusedNode[]>(db, run.id, "fused") ?? [];
    const impactPaths = getArtifact<Record<string, string[]>>(db, run.id, "impactPaths") ?? {};
    const evidence: RouteEvidence[] = fused.map((n) => ({
      routeId: n.routeId,
      exercised: n.exercised,
      observedChanged: n.observedChanged,
      staticImpacted: n.staticImpacted,
      inDiff: n.inDiff,
      isNew: n.isNew ?? false,
      // Without this the miss-cause taxonomy silently collapses to one cause.
      impactPath: impactPaths[n.routeId] ?? [],
    }));
    const runGate = GateSchema.safeParse(getArtifact(db, run.id, "gate"));
    const score = scoreGate(
      { routeIds: parsed.data.routeIds, nothingElse: parsed.data.nothingElse },
      evidence,
      runGate.success ? runGate.data : (serverGate ?? DEFAULT_GATE),
    );
    db.prepare("UPDATE runs SET prediction = ?, score = ?, locked = 1 WHERE id = ?").run(
      JSON.stringify(parsed.data),
      JSON.stringify(score),
      run.id,
    );
    // F-17: record this reviewer's outcome for future checklists (hashed, local-only).
    const surprises = new Set(fused.filter((n) => n.surprise).map((n) => n.routeId));
    recordCalibration(db, hashReviewer(parsed.data.reviewer ?? "local"), {
      runId: run.id,
      ts: new Date().toISOString(),
      recall: score.recall,
      precision: score.precision,
      misses: score.misses,
      surpriseMissed: score.misses.some((m) => surprises.has(m.routeId)),
    });
    const missed = buildQuestions({ fused, claimResults: [], misses: score.misses }).filter(
      (q) => q.template === "MISSED_PREDICTION",
    );
    if (missed.length > 0) {
      const insQ = db.prepare(
        "INSERT INTO questions (id, runId, template, routeId, claimId, status, askedCount, need) VALUES (?, ?, ?, ?, ?, 'OPEN', 0, ?)",
      );
      const texts = getArtifact<Record<string, { text: string; anchors: string[] }>>(db, run.id, "questionTexts") ?? {};
      for (const q of missed) {
        insQ.run(randomUUID(), run.id, q.template, q.routeId, q.claimId, q.need);
        texts[`${q.template}:${q.routeId ?? ""}:${q.claimId ?? ""}`] = { text: q.text, anchors: q.anchors };
      }
      putArtifact(db, run.id, "questionTexts", texts);
    }
    return res.json({ locked: true });
  });

  // Everything below requires a locked prediction (423 otherwise).
  const requireLock = (req: Request, res: Response, next: () => void): void => {
    const run = db.prepare("SELECT locked FROM runs WHERE id = ?").get((req.params.id as string)) as
      | { locked: number }
      | undefined;
    if (!run) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!run.locked) {
      res.status(423).json({ error: "prediction_locked_required" });
      return;
    }
    next();
  };

  app.get("/api/runs/:id/reveal", requireLock, async (req: Request, res: Response) => {
    const run = db.prepare("SELECT score, overrideReason FROM runs WHERE id = ?").get((req.params.id as string)) as {
      score: string;
      overrideReason: string | null;
    };
    const fused = getArtifact<FusedNode[]>(db, (req.params.id as string), "fused") ?? [];
    const claims = getArtifact(db, (req.params.id as string), "claims") ?? [];
    const questions = await readQuestions(req.params.id as string);
    const reviewMode = getArtifact<string>(db, (req.params.id as string), "reviewMode") ?? "full";
    return res.json({ score: JSON.parse(run.score), overrideReason: run.overrideReason, nodes: fused, claims, questions, reviewMode });
  });

  app.post("/api/runs/:id/override", requireLock, (req: Request, res: Response) => {
    const parsed = OverrideSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    db.prepare("UPDATE runs SET overrideReason = ? WHERE id = ?").run(parsed.data.reason, (req.params.id as string));
    return res.json({ overridden: true });
  });

  const readQuestions = async (runId: string): Promise<unknown[]> => {
    const rows = db
      .prepare("SELECT id, template, routeId, claimId, status, askedCount, answer, need FROM questions WHERE runId = ? ORDER BY need DESC")
      .all(runId) as {
      id: string;
      template: string;
      routeId: string | null;
      claimId: string | null;
      status: string;
      askedCount: number;
      answer: string | null;
      need: number;
    }[];
    const texts = getArtifact<Record<string, { text: string; anchors: string[] }>>(db, runId, "questionTexts") ?? {};
    const out: unknown[] = [];
    for (const r of rows) {
      const t = texts[`${r.template}:${r.routeId ?? ""}:${r.claimId ?? ""}`];
      let text: string | null = t ? rephrasePassthrough(t.text) : null;
      // B2 rephrase at read time; the response cache amortizes it to ~1 live
      // call per unique template. Any failure keeps the raw template.
      if (t && opts.phraser) {
        try {
          text = await opts.phraser(t.text, runId);
        } catch {
          text = rephrasePassthrough(t.text);
        }
      }
      out.push({ ...r, text, anchors: t?.anchors ?? [] });
    }
    return out;
  };

  app.get("/api/runs/:id/questions", requireLock, async (req: Request, res: Response) => {
    return res.json({ questions: await readQuestions(req.params.id as string) });
  });

  // Agent summary ingestion: extract + verify claims, refus... update fusion, add contradiction questions.
  app.post("/api/runs/:id/agent-message", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const parsed = z.object({ text: z.string().min(1).max(8000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    if (!opts.extractor) return res.status(503).json({ error: "no_llm" });
    const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
    const knownRoutes = fused.map((n) => n.routeId);
    let extracted: ExtractedClaim[];
    try {
      extracted = await opts.extractor(parsed.data.text, knownRoutes, runId);
    } catch {
      return res.status(503).json({ error: "extraction_failed" });
    }
    const toVerify: VerifyClaim[] = extracted.map((c, i) => ({
      id: `claim-${i}`,
      type: c.type,
      text: c.text,
      routes: c.params.routes,
      ...(c.params.symbol ? { symbol: c.params.symbol } : {}),
      ...(c.params.route ? { route: c.params.route } : {}),
      ...(c.params.breaking === undefined ? {} : { breaking: c.params.breaking }),
    }));
    const results = verifyAll(toVerify, verifierEvidence(db, runId));
    const stored: StoredClaim[] = extracted.map((c, i) => ({
      claimId: `claim-${i}`,
      type: c.type,
      text: c.text,
      verdict: (results[i]?.verdict ?? "UNVERIFIABLE") as StoredClaim["verdict"],
      routes: c.params.routes,
    }));
    putArtifact(db, runId, "claims", stored);
    // Re-fuse with claim verdicts so CONTRADICTED claims mark their routes.
    const evidence: RouteEvidence[] = fused.map((n) => ({
      routeId: n.routeId,
      exercised: n.exercised,
      observedChanged: n.observedChanged,
      staticImpacted: n.staticImpacted,
      inDiff: n.inDiff,
      isNew: n.isNew ?? false,
    }));
    const claimEvidence: ClaimEvidence[] = stored.map((s) => ({
      claimId: s.claimId,
      type: s.type as ClaimType,
      verdict: s.verdict,
      routes: s.routes,
    }));
    putArtifact(db, runId, "fused", fuseRoutes(evidence, claimEvidence));
    const contra = buildQuestions({
      fused,
      claimResults: stored.map((s) => ({ claimId: s.claimId, verdict: s.verdict, routes: s.routes })),
    }).filter((q) => q.template === "CONTRADICTION");
    const insQ = db.prepare(
      "INSERT INTO questions (id, runId, template, routeId, claimId, status, askedCount, need) VALUES (?, ?, ?, ?, ?, 'OPEN', 0, ?)",
    );
    const texts = getArtifact<Record<string, { text: string; anchors: string[] }>>(db, runId, "questionTexts") ?? {};
    for (const q of contra) {
      insQ.run(randomUUID(), runId, q.template, q.routeId, q.claimId, q.need);
      texts[`${q.template}:${q.routeId ?? ""}:${q.claimId ?? ""}`] = { text: q.text, anchors: q.anchors };
    }
    putArtifact(db, runId, "questionTexts", texts);
    return res.json({ claims: stored });
  });

  // Cross-examination: ask the agent one question (quota + follow-ups enforced).
  app.post("/api/runs/:id/questions/:qid/ask", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const qid = req.params.qid as string;
    const row = db.prepare("SELECT id, template, routeId, claimId, status, askedCount, need FROM questions WHERE id = ? AND runId = ?").get(qid, runId) as
      | { id: string; template: string; routeId: string | null; claimId: string | null; status: string; askedCount: number; need: number }
      | undefined;
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.status === "RESOLVED" || row.status === "CONTESTED") {
      return res.json({ status: row.status, terminal: true });
    }
    const asked = db.prepare("SELECT COUNT(*) AS n FROM questions WHERE runId = ? AND askedCount > 0").get(runId) as { n: number };
    if (!quotaAllows(asked.n)) return res.status(429).json({ error: "question_quota_exhausted" });
    const texts = getArtifact<Record<string, { text: string; anchors: string[] }>>(db, runId, "questionTexts") ?? {};
    const t = texts[`${row.template}:${row.routeId ?? ""}:${row.claimId ?? ""}`];
    let questionText = t ? rephrasePassthrough(t.text) : row.template;
    if (t && opts.phraser) {
      try {
        questionText = await opts.phraser(t.text, runId);
      } catch {
        questionText = rephrasePassthrough(t.text);
      }
    }
    const question = `${questionText}\nEvidence:\n${(t?.anchors ?? []).map((a) => `- ${a}`).join("\n")}\nAnswer concisely. If you did not verify something, say "not verified". Do not modify files.`;
    const session = opts.session ?? new MockSession();
    const inputs = getArtifact<{ repoPath: string }>(db, runId, "inputs");
    const { treeFingerprint, treeUnchanged } = await import("@ripplewitness/agents");
    const { createLogger } = await import("./log.js");
    const log = createLogger(runId);
    const treeBefore = inputs ? await treeFingerprint(inputs.repoPath) : null;
    let answer: { text: string; mode: string };
    try {
      answer = await session.ask(question);
    } catch (err) {
      return res.status(503).json({ error: "agent_unavailable", message: String(err) });
    }
    // SEC-07: refuse answers that arrived with a modified subject tree.
    const treeAfter = inputs ? await treeFingerprint(inputs.repoPath) : null;
    if (!treeUnchanged(treeBefore, treeAfter)) {
      log.warn("qna_modified_tree", { qid });
      return res.status(503).json({ error: "qna_modified_tree" });
    }
    const askedCount = row.askedCount + 1;
    if (!opts.extractor) {
      db.prepare("UPDATE questions SET askedCount = ?, answer = ?, status = 'ASKED' WHERE id = ?").run(
        askedCount,
        JSON.stringify({ text: answer.text, followup: null, mode: answer.mode }),
        qid,
      );
      return res.json({ status: "ASKED", resolution: "unavailable_no_llm", answer: answer.text });
    }
    const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
    let verdicts: { verdict: string }[] = [];
    try {
      const extracted = await opts.extractor(answer.text, fused.map((n) => n.routeId), runId);
      verdicts = verifyAll(
        extracted.map((c, i) => ({
          id: `a-${i}`,
          type: c.type,
          text: c.text,
          routes: c.params.routes,
          ...(c.params.symbol ? { symbol: c.params.symbol } : {}),
          ...(c.params.route ? { route: c.params.route } : {}),
        })),
        verifierEvidence(db, runId),
      );
    } catch {
      verdicts = [];
    }
    const anchor = (t?.anchors ?? []).join("; ");
    const explains = row.routeId ? answer.text.includes(row.routeId) : anchor.length > 0 && answer.text.length > 20;
    const assessment = assessAnswer(
      verdicts.map((v) => v.verdict as "SUPPORTED" | "CONTRADICTED" | "UNVERIFIABLE"),
      explains,
      askedCount,
      anchor,
    );
    db.prepare("UPDATE questions SET askedCount = ?, answer = ?, status = ? WHERE id = ?").run(
      askedCount,
      JSON.stringify({ text: answer.text, followup: assessment.followup, mode: answer.mode }),
      assessment.status,
      qid,
    );
    return res.json({ status: assessment.status, followup: assessment.followup });
  });

  app.get("/api/runs/:id/report", requireLock, async (req: Request, res: Response) => {
    // M-09: deterministic PR-comment markdown, rendered from artifacts only.
    const { renderReport } = await import("./report.js");
    const out = renderReport(db, req.params.id as string);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    return res.json({ markdown: out.markdown });
  });

  app.post("/api/runs/:id/receipt", requireLock, async (req: Request, res: Response) => {
    const body = z.object({ algorithm: z.enum(["hmac", "ed25519"]).optional() }).safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "invalid_input" });
    try {
      const out = await issueReceipt(db, opts.home, req.params.id as string, body.data.algorithm ? { algorithm: body.data.algorithm } : undefined);
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      return res.json({ receipt: out.receipt, trailer: trailerValue(out.receipt) });
    } catch {
      return res.status(500).json({ error: "receipt_failed" });
    }
  });

  app.get("/api/runs/:id/receipt", requireLock, (req: Request, res: Response) => {
    const receipt = getArtifact(db, req.params.id as string, "receipt");
    if (!receipt) return res.status(404).json({ error: "no_receipt" });
    return res.json({ receipt });
  });

  app.post("/api/runs/:id/canary", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const parsed = z.object({ file: z.string().min(1).optional(), operator: z.string().optional() }).safeParse(req.body);
    if (!parsed.success || (parsed.data.file && parsed.data.file.split("/").includes(".."))) {
      return res.status(400).json({ error: "invalid_input" });
    }
    const inputs = getArtifact<{ repoPath: string; baseRef: string; headRef: string; scenariosDir: string; appDir?: string; seedDbRel?: string; appStart?: string[] }>(
      db,
      runId,
      "inputs",
    );
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { proposeCanary, proposeWith, validateCanary } = await import("@ripplewitness/canary");
    const { execa } = await import("execa");
    const ops = ["flip_cmp", "off_by_one", "swap_args", "drop_guard", "const_step", "negate_cond"] as const;
    if (parsed.data.operator && !(ops as readonly string[]).includes(parsed.data.operator)) {
      return res.status(400).json({ error: "unknown_operator" });
    }
    // B6: no file => the planner nominates file+operator from changed hunks;
    // code still selects the site and execution still decides acceptance.
    let file = parsed.data.file;
    let operator = parsed.data.operator as (typeof ops)[number] | undefined;
    if (!file) {
      if (!opts.planner) return res.status(503).json({ error: "no_llm" });
      const hunks = await planHunks(inputs);
      const plan = hunks.length === 0 ? null : await opts.planner(hunks, runId);
      if (!plan || plan.file.split("/").includes("..") || !(ops as readonly string[]).includes(plan.operator)) {
        return res.status(422).json({ error: "no_plan" });
      }
      file = plan.file;
      operator = plan.operator as (typeof ops)[number];
    }
    const appPrefix = inputs.appDir ? `${inputs.appDir}/` : "";
    let source: string;
    try {
      const shown = await execa("git", ["show", `HEAD:${appPrefix}${file}`], { cwd: inputs.repoPath });
      source = shown.stdout;
    } catch {
      return res.status(404).json({ error: "file_not_in_head" });
    }
    const candidate = operator ? proposeWith(source, file, operator) : proposeCanary(source, file);
    if (!candidate) return res.status(422).json({ error: "no_mutation_applies" });
    const verdict = await validateCanary({
      repoPath: inputs.repoPath,
      baseRef: inputs.baseRef,
      candidate,
      scenariosDir: inputs.scenariosDir,
      seedDbRel: inputs.seedDbRel ?? "seed/seed.db",
      ...(inputs.appDir ? { appDir: inputs.appDir } : {}),
      ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
      workRoot: `${opts.workRoot}/canary-${runId}`,
    });
    putArtifact(db, runId, "canary", { candidate: { ...candidate, patched: undefined }, verdict });
    return res.json({ candidate: { file: candidate.file, line: candidate.line, operator: candidate.operator, description: candidate.description }, verdict });
  });

  app.get("/api/runs/:id/canary", requireLock, (req: Request, res: Response) => {
    return res.json({ canary: getArtifact(db, req.params.id as string, "canary") });
  });

  /** Changed hunks for the canary planner: app-relative files, added+context text. Never throws. */
  const planHunks = async (inputs: { repoPath: string; baseRef: string; headRef: string; appDir?: string }): Promise<{ file: string; startLine: number; text: string }[]> => {
    try {
      const { execa } = await import("execa");
      const { parseUnifiedDiff } = await import("./diff.js");
      const { stdout } = await execa("git", ["diff", inputs.baseRef, inputs.headRef], { cwd: inputs.repoPath, maxBuffer: 8 * 1024 * 1024 });
      const prefix = inputs.appDir && inputs.appDir !== "." ? `${inputs.appDir.replace(/\/$/, "")}/` : "";
      const out: { file: string; startLine: number; text: string }[] = [];
      for (const f of parseUnifiedDiff(stdout)) {
        if (prefix && !f.file.startsWith(prefix)) continue;
        const rel = prefix ? f.file.slice(prefix.length) : f.file;
        for (const h of f.hunks) {
          const text = h.lines
            .filter((l) => l.type !== "del")
            .map((l) => `${l.type === "add" ? "+" : " "}${l.text}`)
            .join("\n");
          out.push({ file: rel, startLine: h.newStart, text });
        }
      }
      return out;
    } catch {
      return [];
    }
  };

  // Blind-first (F-01): human findings first, AI review only after (423 until then).
  app.post("/api/runs/:id/findings", requireLock, (req: Request, res: Response) => {
    const parsed = z
      .object({
        findings: z
          .array(z.object({ file: z.string(), startLine: z.number(), endLine: z.number(), note: z.string() }))
          .max(30),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    putArtifact(db, req.params.id as string, "humanFindings", parsed.data.findings);
    return res.json({ recorded: parsed.data.findings.length });
  });

  app.post("/api/runs/:id/ai-review", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (!getArtifact(db, runId, "humanFindings")) {
      return res.status(423).json({ error: "human_findings_required_first" });
    }
    if (!opts.reviewer) return res.status(503).json({ error: "no_llm" });
    const inputs = getArtifact<{ repoPath: string; baseRef: string; headRef: string }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { execa } = await import("execa");
    let diff: string;
    try {
      diff = (await execa("git", ["diff", inputs.baseRef, inputs.headRef], { cwd: inputs.repoPath })).stdout;
    } catch {
      return res.status(503).json({ error: "reviewer_failed" });
    }
    let raw: unknown;
    try {
      raw = await opts.reviewer(diff, runId);
    } catch {
      return res.status(503).json({ error: "reviewer_failed" });
    }
    const parsed = z.object({ findings: z.array(FindingSchema) }).safeParse(raw);
    if (!parsed.success) return res.status(503).json({ error: "reviewer_schema_invalid" });
    const result = validateFindings(parsed.data.findings, parseDiffHunks(diff));
    putArtifact(db, runId, "aiReview", result);
    return res.json(result);
  });

  app.post("/api/runs/:id/explain", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const parsed = z.object({ routeId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    if (!opts.explainer) return res.status(503).json({ error: "no_llm" });
    const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
    const node = fused.find((n) => n.routeId === parsed.data.routeId);
    if (!node) return res.status(404).json({ error: "unknown_route" });
    const paths = getArtifact<Record<string, string[]>>(db, runId, "impactPaths") ?? {};
    const routeDiffs =
      getArtifact<{ routeId: string; diffs: { path: string; before: unknown; after: unknown }[] }[]>(db, runId, "routeDiffs") ?? [];
    const rd = routeDiffs.find((r) => r.routeId === parsed.data.routeId);
    const input: ExplainerInput = {
      routeId: node.routeId,
      hunk: `status=${node.status} static=${node.staticImpacted} exercised=${node.exercised}`,
      neighbors: paths[node.routeId] ?? [],
      observations: (rd?.diffs ?? []).map((d) => `${d.path}: ${JSON.stringify(d.before)}→${JSON.stringify(d.after)}`),
      knownRoutes: fused.map((n) => n.routeId),
      ...(opts.agentDefaults?.explainerMaxSentences ? { maxSentences: opts.agentDefaults.explainerMaxSentences } : {}),
    };
    let raw: unknown;
    try {
      raw = await opts.explainer(input, runId);
    } catch {
      return res.status(503).json({ error: "explainer_failed" });
    }
    const { ExplanationSchema } = await import("@ripplewitness/agents");
    const valid = ExplanationSchema.safeParse(raw);
    if (!valid.success) return res.status(503).json({ error: "explainer_schema_invalid" });
    const check = validateExplanation(valid.data, input);
    if (!check.ok) return res.status(503).json({ error: "explainer_traceability", reason: check.reason });
    return res.json({ explanation: valid.data });
  });

  app.post("/api/runs/:id/summary", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (!opts.summarizer) return res.status(503).json({ error: "no_llm" });
    const inputs = getArtifact<{ repoPath: string; baseRef: string; headRef: string }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
    const { execa } = await import("execa");
    const { stdout: diff } = await execa("git", ["diff", "--unified=1", inputs.baseRef, inputs.headRef], { cwd: inputs.repoPath });
    const input: SummaryInput = {
      diff,
      observations: fused.filter((n) => n.exercised).map((n) => ({ routeId: n.routeId, changed: n.observedChanged })),
      exercised: fused.filter((n) => n.exercised).map((n) => n.routeId),
      unexercisedImpacted: fused.filter((n) => !n.exercised && n.staticImpacted).map((n) => n.routeId),
      ...(opts.agentDefaults?.summaryStyle ? { style: opts.agentDefaults.summaryStyle } : {}),
    };
    let raw: unknown;
    try {
      raw = await opts.summarizer(input, runId);
    } catch {
      return res.status(503).json({ error: "summary_failed" });
    }
    const { SummarySchema } = await import("@ripplewitness/agents");
    const valid = SummarySchema.safeParse(raw);
    if (!valid.success) return res.status(503).json({ error: "summary_schema_invalid" });
    const check = validateSummary(valid.data, input);
    if (!check.ok) return res.status(503).json({ error: "summary_validation", reason: check.reason });
    putArtifact(db, runId, "summary", valid.data);
    return res.json({ summary: valid.data });
  });

  app.post("/api/runs/:id/harvest", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const inputs = getArtifact<{
      repoPath: string;
      baseRef: string;
      headRef: string;
      appDir?: string;
      seedDbRel?: string;
      language?: string;
      appStart?: string[];
    }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { detectLanguage } = await import("@ripplewitness/graph");
    const { join } = await import("node:path");
    const appSub = inputs.appDir && inputs.appDir !== "." ? inputs.appDir : ".";
    const language = inputs.language ?? detectLanguage(join(inputs.repoPath, appSub));
    if (language !== "python") return res.status(422).json({ error: "harvest_requires_python" });
    const { createWorktree, diffHarvest, harvestToScenarios, provisionHarvestEnv, removeWorktree, runHarvest } =
      await import("@ripplewitness/replay");
    const baseWt = `${opts.workRoot}/harvest-base-${runId}`;
    const headWt = `${opts.workRoot}/harvest-head-${runId}`;
    try {
      await createWorktree(inputs.repoPath, inputs.baseRef, baseWt);
      await createWorktree(inputs.repoPath, inputs.headRef, headWt);
    } catch {
      return res.status(409).json({ error: "worktree_failed" });
    }
    try {
      const baseEnv = await provisionHarvestEnv(join(baseWt, appSub));
      const headEnv = await provisionHarvestEnv(join(headWt, appSub));
      if (!baseEnv.ok || !headEnv.ok) {
        return res.status(503).json({ error: "harvest_provision_failed" });
      }
      const b = await runHarvest(join(baseWt, appSub), { python: baseEnv.python });
      const h = await runHarvest(join(headWt, appSub), { python: headEnv.python });
      if (!b.ok || !h.ok) return res.status(503).json({ error: "harvest_run_failed" });
      const { flips, passingBoth } = diffHarvest(b.result, h.result);
      putArtifact(db, runId, "harvestFlips", flips);
      if (passingBoth.length === 0) return res.json({ flips, kept: [], dropped: [] });
      // Cap adoption candidates to bound replay cost; the rest stay listed.
      const cands = harvestToScenarios(passingBoth.slice(0, 10)).map((c) => ({ ...c, source: `harvest:${c.sourceTest}` }));
      const { verifyAndAdopt } = await import("./adopt.js");
      const gate = GateSchema.safeParse(getArtifact(db, runId, "gate"));
      const adopted = await verifyAndAdopt(
        db,
        runId,
        {
          repoPath: inputs.repoPath,
          baseRef: inputs.baseRef,
          headRef: inputs.headRef,
          seedDbRel: inputs.seedDbRel ?? "seed/seed.db",
          ...(inputs.appDir ? { appDir: inputs.appDir } : {}),
          ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
          ...(inputs.language === "python" || inputs.language === "node" ? { language: inputs.language } : {}),
        },
        opts.workRoot,
        cands,
        gate.success ? gate.data : (opts.gate ?? DEFAULT_GATE),
      );
      return res.json({ flips, kept: adopted.kept, dropped: adopted.dropped });
    } finally {
      await removeWorktree(inputs.repoPath, baseWt).catch(() => {});
      await removeWorktree(inputs.repoPath, headWt).catch(() => {});
    }
  });

  app.post("/api/runs/:id/forge", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const inputs = getArtifact<{
      repoPath: string;
      baseRef: string;
      headRef: string;
      appDir?: string;
      seedDbRel?: string;
      language?: string;
      appStart?: string[];
    }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { detectLanguage } = await import("@ripplewitness/graph");
    const { join } = await import("node:path");
    const appSub = inputs.appDir && inputs.appDir !== "." ? inputs.appDir : ".";
    const language = inputs.language ?? detectLanguage(join(inputs.repoPath, appSub));
    if (language !== "python" && language !== "node") return res.status(422).json({ error: "forge_no_openapi" });
    const { createWorktree, removeWorktree } = await import("@ripplewitness/replay");
    const { fetchOpenApiDoc, synthesizeFromOpenApi } = await import("./forge.js");
    const wt = `${opts.workRoot}/forge-${runId}`;
    try {
      await createWorktree(inputs.repoPath, inputs.baseRef, wt);
    } catch {
      return res.status(409).json({ error: "worktree_failed" });
    }
    try {
      const fetched = await fetchOpenApiDoc({
        worktreeAppDir: join(wt, appSub),
        sourceAppDir: join(inputs.repoPath, appSub),
        language: language as "node" | "python",
        ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
        ...(inputs.seedDbRel ? { seedDb: join(wt, appSub, inputs.seedDbRel) } : {}),
      });
      if (!fetched.ok) return res.status(503).json({ error: "forge_no_openapi", reason: fetched.error });
      const cands = synthesizeFromOpenApi(fetched.doc).slice(0, 15);
      if (cands.length === 0) return res.json({ synthesized: 0, kept: [], dropped: [] });
      const { verifyAndAdopt } = await import("./adopt.js");
      const gate = GateSchema.safeParse(getArtifact(db, runId, "gate"));
      const adopted = await verifyAndAdopt(
        db,
        runId,
        {
          repoPath: inputs.repoPath,
          baseRef: inputs.baseRef,
          headRef: inputs.headRef,
          seedDbRel: inputs.seedDbRel ?? "seed/seed.db",
          ...(inputs.appDir ? { appDir: inputs.appDir } : {}),
          ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
          ...(inputs.language === "python" || inputs.language === "node" ? { language: inputs.language } : {}),
        },
        opts.workRoot,
        cands,
        gate.success ? gate.data : (opts.gate ?? DEFAULT_GATE),
      );
      return res.json({ synthesized: cands.length, kept: adopted.kept, dropped: adopted.dropped });
    } finally {
      await removeWorktree(inputs.repoPath, wt).catch(() => {});
    }
  });

  // F-16 Causal Ablation: plan candidates for a route's observed diff.
  app.get("/api/runs/:id/ablations", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const routeId = req.query.routeId;
    if (typeof routeId !== "string" || routeId.length === 0) return res.status(400).json({ error: "routeId_required" });
    const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
    if (!fused.some((n) => n.routeId === routeId)) return res.status(404).json({ error: "unknown_route" });
    const inputs = getArtifact<{ repoPath: string; baseRef: string; headRef: string; appDir?: string }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const paths = getArtifact<Record<string, string[]>>(db, runId, "impactPaths") ?? {};
    const graph = getArtifact<{ nodes: { id: string; file?: string }[] }>(db, runId, "graph");
    const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n.file]));
    const prefix = inputs.appDir && inputs.appDir !== "." ? `${inputs.appDir.replace(/\/$/, "")}/` : "";
    const pathFiles = [...new Set((paths[routeId] ?? []).map((id) => byId.get(id)).filter((f): f is string => !!f))].map(
      (f) => `${prefix}${f}`,
    );
    const { planForRoute } = await import("./ablate.js");
    return res.json({ routeId, candidates: await planForRoute(inputs, opts.workRoot, pathFiles) });
  });

  // F-16 Causal Ablation: neutralize one coupling, replay, and judge the explanation.
  app.post("/api/runs/:id/ablate", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const parsed = z
      .object({
        routeId: z.string().min(1).max(300),
        kind: z.enum(["pin_file", "drop_event"]),
        file: z.string().min(1).max(500),
        event: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success || parsed.data.file.split("/").includes("..")) return res.status(400).json({ error: "invalid_input" });
    const inputs = getArtifact<{
      repoPath: string;
      baseRef: string;
      headRef: string;
      scenariosDir: string;
      appDir?: string;
      seedDbRel?: string;
      appStart?: string[];
      language?: "node" | "python" | "go";
    }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { runAblation } = await import("./ablate.js");
    return res.json(await runAblation(db, runId, opts.workRoot, inputs, parsed.data));
  });

  // F-15 auto-loop: turn the UNVERIFIED queue into exercised routes.
  app.post("/api/runs/:id/forge/auto", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const inputs = getArtifact<{
      repoPath: string;
      baseRef: string;
      headRef: string;
      appDir?: string;
      seedDbRel?: string;
      language?: string;
      appStart?: string[];
    }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { unverifiedQueue, synthesizeTemplates, synthesizeFromOpenApi, fetchOpenApiDoc } = await import("./forge.js");
    const { resolveStepRoutes } = await import("@ripplewitness/replay");
    const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
    const queue = unverifiedQueue(fused).slice(0, 10);
    if (queue.length === 0) return res.json({ queued: [], synthesized: 0, kept: [], dropped: [] });
    const knownRoutes = fused.map((n) => n.routeId);
    // Source 1: OpenAPI synthesis filtered to the queue (best placeholders).
    let openapi: { id: string; group: string; method: string; path: string; headers: Record<string, string>; body: unknown; source: string }[] = [];
    const appSub = inputs.appDir && inputs.appDir !== "." ? inputs.appDir : ".";
    const language = inputs.language ?? (await import("@ripplewitness/graph")).detectLanguage((await import("node:path")).join(inputs.repoPath, appSub));
    if (language === "python" || language === "node") {
      const { createWorktree, removeWorktree } = await import("@ripplewitness/replay");
      const wt = `${opts.workRoot}/forge-auto-${runId}`;
      try {
        await createWorktree(inputs.repoPath, inputs.baseRef, wt);
        const fetched = await fetchOpenApiDoc({
          worktreeAppDir: (await import("node:path")).join(wt, appSub),
          sourceAppDir: (await import("node:path")).join(inputs.repoPath, appSub),
          language: language as "node" | "python",
          ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
          ...(inputs.seedDbRel ? { seedDb: (await import("node:path")).join(wt, appSub, inputs.seedDbRel) } : {}),
        });
        if (fetched.ok) {
          openapi = synthesizeFromOpenApi(fetched.doc).filter((c) =>
            resolveStepRoutes(c.method, c.path, knownRoutes).some((r) => queue.includes(r)),
          );
        }
      } catch {
        openapi = [];
      } finally {
        await removeWorktree(inputs.repoPath, wt).catch(() => {});
      }
    }
    const covered = new Set(openapi.flatMap((c) => resolveStepRoutes(c.method, c.path, knownRoutes)));
    const { candidates: templates, skipped } = synthesizeTemplates(queue.filter((r) => !covered.has(r)));
    const cands = [...openapi.slice(0, 15), ...templates].slice(0, 15);
    if (cands.length === 0) return res.json({ queued: queue, synthesized: 0, kept: [], dropped: [], skipped });
    const { verifyAndAdopt } = await import("./adopt.js");
    const gate = GateSchema.safeParse(getArtifact(db, runId, "gate"));
    const adopted = await verifyAndAdopt(
      db,
      runId,
      {
        repoPath: inputs.repoPath,
        baseRef: inputs.baseRef,
        headRef: inputs.headRef,
        seedDbRel: inputs.seedDbRel ?? "seed/seed.db",
        ...(inputs.appDir ? { appDir: inputs.appDir } : {}),
        ...(inputs.appStart ? { appStart: inputs.appStart } : {}),
        ...(inputs.language === "python" || inputs.language === "node" ? { language: inputs.language } : {}),
      },
      opts.workRoot,
      cands,
      gate.success ? gate.data : (opts.gate ?? DEFAULT_GATE),
    );
    return res.json({ queued: queue, synthesized: cands.length, kept: adopted.kept, dropped: adopted.dropped, skipped });
  });

  // F-10 Predict-then-Run: grade predicted fn outputs by running base vs head.
  app.post("/api/runs/:id/fn-run", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const parsed = z
      .object({
        fn: z.string().min(1).max(300),
        args: z.array(z.unknown()).max(20).optional(),
        kwargs: z.record(z.unknown()).optional(),
        predictedBase: z.unknown().optional(),
        predictedHead: z.unknown().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success || parsed.data.fn.split("/").includes("..")) return res.status(400).json({ error: "invalid_input" });
    const inputs = getArtifact<{ repoPath: string; baseRef: string; headRef: string; appDir?: string; seedDbRel?: string }>(
      db,
      runId,
      "inputs",
    );
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const lang = getArtifact<{ effective: string }>(db, runId, "language");
    if (lang?.effective === "go") return res.status(422).json({ error: "fnrun_go_unsupported" });
    const language = lang?.effective === "python" ? "python" : "node";
    const { runFnBothSides } = await import("./fnrun.js");
    const result = await runFnBothSides(db, runId, opts.workRoot, { ...inputs, language }, parsed.data);
    return res.json(result);
  });

  // Agent usage metrics (AGENTS.md B8): per-run calls, tokens, repairs, latency.
  app.get("/api/runs/:id/metrics", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const run = db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    if (!run) return res.status(404).json({ error: "not_found" });
    try {
      return res.json({ metrics: metaClientForRun(runId).getMetrics() });
    } catch {
      return res.status(503).json({ error: "no_llm" });
    }
  });

  return app;
}
