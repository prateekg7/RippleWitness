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
  parseDiffHunks,
  validateExplanation,
  validateFindings,
  validateSummary,
} from "@ripplewitness/agents";
import { getArtifact, putArtifact } from "./store.js";
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
});
const PredictSchema = z.object({ routeIds: z.array(z.string()).max(200), nothingElse: z.boolean() });
const OverrideSchema = z.object({ reason: z.string().min(1).max(500) });

export interface ServerOptions {
  workRoot: string;
  home: string;
  gate?: { minRecall: number; minPrecision: number };
  session?: AgentSessionPort;
  /** Claim extraction hook (LLM in prod, stub in tests). Absent => 503 no_llm. */
  extractor?: (text: string, knownRoutes: string[]) => Promise<ExtractedClaim[]>;
  reviewer?: (diff: string) => Promise<unknown>;
  explainer?: (input: ExplainerInput) => Promise<unknown>;
  summarizer?: (input: SummaryInput) => Promise<unknown>;
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

export function createServer(db: Database.Database, opts: ServerOptions): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const serverGate = opts.gate;

  app.get("/api/health", (_req: Request, res: Response) => res.json({ ok: true }));

  app.post("/api/analyze", (req: Request, res: Response) => {
    const parsed = AnalyzeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    const runId = randomUUID();
    if (parsed.data.gate) putArtifact(db, runId, "gate", parsed.data.gate);
    const input: AnalyzeInput = {
      repoPath: parsed.data.repoPath,
      baseRef: parsed.data.baseRef,
      headRef: parsed.data.headRef,
      scenariosDir: parsed.data.scenariosDir,
      ...(parsed.data.appDir ? { appDir: parsed.data.appDir } : {}),
      ...(parsed.data.seedDbRel ? { seedDbRel: parsed.data.seedDbRel } : {}),
      ...(parsed.data.flakeGuard === undefined ? {} : { flakeGuard: parsed.data.flakeGuard }),
    };
    void runAnalysis(db, opts.workRoot, input, runId);
    return res.status(202).json({ runId });
  });

  app.get("/api/runs/:id/status", (req: Request, res: Response) => {
    const row = db.prepare("SELECT id, status, stages, locked FROM runs WHERE id = ?").get((req.params.id as string));
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json(row);
  });

  // Pre-lock map: static shape only — no observed status (anti-anchoring).
  app.get("/api/runs/:id/map", (req: Request, res: Response) => {
    const run = db.prepare("SELECT id, locked FROM runs WHERE id = ?").get((req.params.id as string)) as
      | { id: string; locked: number }
      | undefined;
    if (!run) return res.status(404).json({ error: "not_found" });
    const fused = getArtifact<FusedNode[]>(db, run.id, "fused") ?? [];
    if (run.locked) return res.json({ nodes: fused });
    return res.json({
      nodes: fused.map((n) => ({
        routeId: n.routeId,
        staticImpacted: n.staticImpacted,
        inDiff: n.inDiff,
        exercised: n.exercised,
      })),
    });
  });

  app.post("/api/runs/:id/predict", (req: Request, res: Response) => {
    const run = db.prepare("SELECT id, locked, status FROM runs WHERE id = ?").get((req.params.id as string)) as
      | { id: string; locked: number; status: string }
      | undefined;
    if (!run) return res.status(404).json({ error: "not_found" });
    if (run.locked) return res.status(409).json({ error: "already_locked" });
    if (run.status !== "ready") return res.status(409).json({ error: `not_ready:${run.status}` });
    const parsed = PredictSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    const fused = getArtifact<FusedNode[]>(db, run.id, "fused") ?? [];
    const evidence: RouteEvidence[] = fused.map((n) => ({
      routeId: n.routeId,
      exercised: n.exercised,
      observedChanged: n.observedChanged,
      staticImpacted: n.staticImpacted,
      inDiff: n.inDiff,
      isNew: false,
    }));
    const runGate = GateSchema.safeParse(getArtifact(db, run.id, "gate"));
    const score = scoreGate(parsed.data, evidence, runGate.success ? runGate.data : (serverGate ?? DEFAULT_GATE));
    db.prepare("UPDATE runs SET prediction = ?, score = ?, locked = 1 WHERE id = ?").run(
      JSON.stringify(parsed.data),
      JSON.stringify(score),
      run.id,
    );
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

  app.get("/api/runs/:id/reveal", requireLock, (req: Request, res: Response) => {
    const run = db.prepare("SELECT score, overrideReason FROM runs WHERE id = ?").get((req.params.id as string)) as {
      score: string;
      overrideReason: string | null;
    };
    const fused = getArtifact<FusedNode[]>(db, (req.params.id as string), "fused") ?? [];
    const claims = getArtifact(db, (req.params.id as string), "claims") ?? [];
    const questions = getArtifact(db, (req.params.id as string), "questions") ?? [];
    return res.json({ score: JSON.parse(run.score), overrideReason: run.overrideReason, nodes: fused, claims, questions });
  });

  app.post("/api/runs/:id/override", requireLock, (req: Request, res: Response) => {
    const parsed = OverrideSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    db.prepare("UPDATE runs SET overrideReason = ? WHERE id = ?").run(parsed.data.reason, (req.params.id as string));
    return res.json({ overridden: true });
  });

  const readQuestions = (runId: string): unknown[] => {
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
    return rows.map((r) => {
      const t = texts[`${r.template}:${r.routeId ?? ""}:${r.claimId ?? ""}`];
      return { ...r, text: t ? rephrasePassthrough(t.text) : null, anchors: t?.anchors ?? [] };
    });
  };

  app.get("/api/runs/:id/questions", requireLock, (req: Request, res: Response) => {
    return res.json({ questions: readQuestions(req.params.id as string) });
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
      extracted = await opts.extractor(parsed.data.text, knownRoutes);
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
      isNew: false,
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
    const question = `${t ? rephrasePassthrough(t.text) : row.template}\nEvidence:\n${(t?.anchors ?? []).map((a) => `- ${a}`).join("\n")}\nAnswer concisely. If you did not verify something, say "not verified". Do not modify files.`;
    const session = opts.session ?? new MockSession();
    let answer: { text: string; mode: string };
    try {
      answer = await session.ask(question);
    } catch (err) {
      return res.status(503).json({ error: "agent_unavailable", message: String(err) });
    }
    const askedCount = row.askedCount + 1;
    if (!opts.extractor) {
      db.prepare("UPDATE questions SET askedCount = ?, answer = ?, status = 'ASKED' WHERE id = ?").run(
        askedCount,
        JSON.stringify({ text: answer.text, followup: null }),
        qid,
      );
      return res.json({ status: "ASKED", resolution: "unavailable_no_llm", answer: answer.text });
    }
    const fused = getArtifact<FusedNode[]>(db, runId, "fused") ?? [];
    let verdicts: { verdict: string }[] = [];
    try {
      const extracted = await opts.extractor(answer.text, fused.map((n) => n.routeId));
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
      JSON.stringify({ text: answer.text, followup: assessment.followup }),
      assessment.status,
      qid,
    );
    return res.json({ status: assessment.status, followup: assessment.followup });
  });

  app.post("/api/runs/:id/receipt", requireLock, async (req: Request, res: Response) => {
    const out = await issueReceipt(db, opts.home, req.params.id as string);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    return res.json({ receipt: out.receipt, trailer: trailerValue(out.receipt) });
  });

  app.get("/api/runs/:id/receipt", requireLock, (req: Request, res: Response) => {
    const receipt = getArtifact(db, req.params.id as string, "receipt");
    if (!receipt) return res.status(404).json({ error: "no_receipt" });
    return res.json({ receipt });
  });

  app.post("/api/runs/:id/canary", requireLock, async (req: Request, res: Response) => {
    const runId = req.params.id as string;
    const parsed = z.object({ file: z.string().min(1), operator: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
    const inputs = getArtifact<{ repoPath: string; baseRef: string; scenariosDir: string; appDir?: string }>(db, runId, "inputs");
    if (!inputs) return res.status(409).json({ error: "inputs_missing" });
    const { proposeCanary, proposeWith, validateCanary } = await import("@ripplewitness/canary");
    const { execa } = await import("execa");
    let source: string;
    try {
      const shown = await execa("git", ["show", `HEAD:${inputs.appDir ? `${inputs.appDir}/` : ""}${parsed.data.file}`], { cwd: inputs.repoPath });
      source = shown.stdout;
    } catch {
      return res.status(404).json({ error: "file_not_in_head" });
    }
    const ops = ["flip_cmp", "off_by_one", "swap_args", "drop_guard", "const_step", "negate_cond"] as const;
    if (parsed.data.operator && !(ops as readonly string[]).includes(parsed.data.operator)) {
      return res.status(400).json({ error: "unknown_operator" });
    }
    const candidate = parsed.data.operator
      ? proposeWith(source, parsed.data.file, parsed.data.operator as (typeof ops)[number])
      : proposeCanary(source, parsed.data.file);
    if (!candidate) return res.status(422).json({ error: "no_mutation_applies" });
    const verdict = await validateCanary({
      repoPath: inputs.repoPath,
      baseRef: inputs.baseRef,
      candidate,
      scenariosDir: inputs.scenariosDir,
      seedDbRel: "seed/seed.db",
      ...(inputs.appDir ? { appDir: inputs.appDir } : {}),
      workRoot: `${opts.workRoot}/canary-${runId}`,
    });
    putArtifact(db, runId, "canary", { candidate: { ...candidate, patched: undefined }, verdict });
    return res.json({ candidate: { file: candidate.file, line: candidate.line, operator: candidate.operator, description: candidate.description }, verdict });
  });

  app.get("/api/runs/:id/canary", requireLock, (req: Request, res: Response) => {
    return res.json({ canary: getArtifact(db, req.params.id as string, "canary") });
  });

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
    const { stdout: diff } = await execa("git", ["diff", inputs.baseRef, inputs.headRef], { cwd: inputs.repoPath });
    let raw: unknown;
    try {
      raw = await opts.reviewer(diff);
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
    };
    let raw: unknown;
    try {
      raw = await opts.explainer(input);
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
    };
    let raw: unknown;
    try {
      raw = await opts.summarizer(input);
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

  return app;
}
