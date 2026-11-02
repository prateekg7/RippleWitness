import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { MockSession } from "@ripplewitness/agents";
import type { ExtractedClaim } from "@ripplewitness/agents";
import { createServer } from "./app.js";
import { openStore } from "./store.js";

function stubExtractor(text: string, knownRoutes: string[]): Promise<ExtractedClaim[]> {
  const has = (s: string): boolean => text.includes(s);
  if (has("Only touches checkout")) {
    return Promise.resolve([
      { type: "SCOPE", text, sourceSpan: [0, text.length], params: { routes: ["route:POST /checkout"] } },
    ]);
  }
  if (has("route:GET /reports/sales changed")) {
    return Promise.resolve([
      { type: "SCOPE", text, sourceSpan: [0, text.length], params: { routes: ["route:GET /reports/sales"] } },
    ]);
  }
  void knownRoutes;
  return Promise.resolve([]);
}

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHOP = join(ROOT, "demo", "shop-api");
const SCEN = join(ROOT, "demo", "scenarios");
const PRS = join(ROOT, "demo", "prs");

async function buildRepo(patch: string | null): Promise<{ repoPath: string; base: string; head: string }> {
  const repoPath = mkdtempSync(join(tmpdir(), "rw-srv-"));
  cpSync(SHOP, repoPath, { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes(".git") });
  await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
  await exec("git", ["config", "user.email", "t@local"], { cwd: repoPath });
  await exec("git", ["config", "user.name", "t"], { cwd: repoPath });
  writeFileSync(join(repoPath, ".gitignore"), "node_modules\n");
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["commit", "-qm", "base"], { cwd: repoPath });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  let head = base;
  if (patch) {
    await exec("git", ["checkout", "-qb", "pr"], { cwd: repoPath });
    await exec("git", ["apply", join(PRS, patch)], { cwd: repoPath });
    await exec("git", ["add", "-A"], { cwd: repoPath });
    await exec("git", ["commit", "-qm", "pr"], { cwd: repoPath });
    head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  }
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(SHOP, "node_modules"), join(repoPath, "node_modules"), "dir");
  return { repoPath, base, head };
}

function subset(groups: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rw-srv-scen-"));
  for (const f of readdirSync(SCEN)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const s = JSON.parse(readFileSync(join(SCEN, f), "utf8")) as { group: string };
    if (groups.includes(s.group)) writeFileSync(join(dir, f), readFileSync(join(SCEN, f)));
  }
  return dir;
}

afterAll(() => {});

describe("server API (C-06)", () => {
  it("analyze -> lock -> reveal -> override on PR-00", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wt-")), home: mkdtempSync(join(tmpdir(), "rw-srv-home-")) });
    const { repoPath, base, head } = await buildRepo("PR-00.patch");
    const started = await request(app)
      .post("/api/analyze")
      .send({ repoPath, baseRef: base, headRef: head, scenariosDir: subset(["checkout", "reports"]), flakeGuard: false });
    expect(started.status).toBe(202);
    const runId = (started.body as { runId: string }).runId;

    let status = "";
    for (let i = 0; i < 120; i++) {
      const r = await request(app).get(`/api/runs/${runId}/status`);
      status = (r.body as { status: string }).status;
      if (status === "ready" || status === "static-only" || status === "failed") break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    expect(status).toBe("ready");

    const pre = await request(app).get(`/api/runs/${runId}/map`);
    expect(pre.status).toBe(200);
    expect(JSON.stringify(pre.body)).not.toContain("SURPRISE");
    expect(JSON.stringify(pre.body)).not.toContain("observedChanged");

    expect((await request(app).get(`/api/runs/${runId}/reveal`)).status).toBe(423);
    expect((await request(app).get(`/api/runs/${runId}/questions`)).status).toBe(423);

    const lock = await request(app)
      .post(`/api/runs/${runId}/predict`)
      .send({ routeIds: ["route:POST /checkout"], nothingElse: false });
    expect(lock.status).toBe(200);
    expect((await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: true })).status).toBe(409);

    const reveal = await request(app).get(`/api/runs/${runId}/reveal`);
    expect(reveal.status).toBe(200);
    const body = reveal.body as { score: { misses: { routeId: string }[] }; nodes: { routeId: string; status: string }[] };
    expect(body.nodes.find((n) => n.routeId === "route:POST /checkout")?.status).toBe("CONFIRMED");
    expect(body.nodes.find((n) => n.routeId === "route:GET /reports/sales")?.status).toBe("SURPRISE");
    expect(body.score.misses.map((m) => m.routeId)).toContain("route:GET /reports/sales");

    const ov = await request(app).post(`/api/runs/${runId}/override`).send({ reason: "demo override" });
    expect(ov.status).toBe(200);
    const reveal2 = await request(app).get(`/api/runs/${runId}/reveal`);
    expect((reveal2.body as { overrideReason: string }).overrideReason).toBe("demo override");
    db.close();
  });

  it("cross-exam: agent message -> contradiction -> ask -> resolved; empty answers follow up then park", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-c.db`));
    const app = createServer(db, {
      workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wtc-")),
      home: mkdtempSync(join(tmpdir(), "rw-srv-homec-")),
      session: new MockSession(["route:GET /reports/sales changed via the event bus.", "not verified"]),
      extractor: stubExtractor,
    });
    const { repoPath, base, head } = await buildRepo("PR-00.patch");
    const started = await request(app)
      .post("/api/analyze")
      .send({ repoPath, baseRef: base, headRef: head, scenariosDir: subset(["checkout", "reports"]), flakeGuard: false });
    const runId = (started.body as { runId: string }).runId;
    for (let i = 0; i < 120; i++) {
      const r = await request(app).get(`/api/runs/${runId}/status`);
      if ((r.body as { status: string }).status === "ready") break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: ["route:POST /checkout"], nothingElse: false });

    const am = await request(app).post(`/api/runs/${runId}/agent-message`).send({ text: "Only touches checkout." });
    expect(am.status).toBe(200);
    expect((am.body as { claims: { verdict: string }[] }).claims[0]?.verdict).toBe("CONTRADICTED");

    const qs = await request(app).get(`/api/runs/${runId}/questions`);
    const questions = (qs.body as { questions: { id: string; template: string; routeId: string | null }[] }).questions;
    const surprise = questions.find((q) => q.template === "SURPRISE_RIPPLE");
    expect(surprise).toBeDefined();
    const asked = await request(app).post(`/api/runs/${runId}/questions/${surprise?.id as string}/ask`).send({});
    expect((asked.body as { status: string }).status).toBe("RESOLVED");

    const creep = questions.find((q) => q.template === "SCOPE_CREEP") ?? questions.find((q) => q.template === "MISSED_PREDICTION");
    if (creep) {
      const a1 = await request(app).post(`/api/runs/${runId}/questions/${creep.id}/ask`).send({});
      expect((a1.body as { status: string }).status).toBe("OPEN");
      expect((a1.body as { followup: string }).followup).toContain("Follow-up");
      await request(app).post(`/api/runs/${runId}/questions/${creep.id}/ask`).send({});
      const a3 = await request(app).post(`/api/runs/${runId}/questions/${creep.id}/ask`).send({});
      expect((a3.body as { status: string }).status).toBe("ASKED");
    }
    db.close();
  });

  it("receipt: 409 until passed, then issues signed receipt with git note", async () => {
    const home = mkdtempSync(join(tmpdir(), "rw-srv-homed-"));
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-d.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wtd-")), home });
    const { repoPath, base, head } = await buildRepo("PR-01.patch");
    const started = await request(app)
      .post("/api/analyze")
      .send({ repoPath, baseRef: base, headRef: head, scenariosDir: subset(["health"]), flakeGuard: false });
    const runId = (started.body as { runId: string }).runId;
    for (let i = 0; i < 120; i++) {
      const r = await request(app).get(`/api/runs/${runId}/status`);
      if ((r.body as { status: string }).status === "ready") break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    expect((await request(app).post(`/api/runs/${runId}/receipt`).send({})).status).toBe(423);
    await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: true });
    const rc = await request(app).post(`/api/runs/${runId}/receipt`).send({});
    expect(rc.status).toBe(200);
    expect((rc.body as { trailer: string }).trailer).toMatch(/^RippleWitness-Receipt: /);
    const note = await exec("git", ["notes", "--ref=refs/notes/ripplewitness", "show", head], { cwd: repoPath });
    expect(note.stdout).toContain(runId);
    const again = await request(app).get(`/api/runs/${runId}/receipt`);
    expect(again.status).toBe(200);
    db.close();
  });

  it("assistants: blind-first gate, explain traceability, summary coverage", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-e.db`));
    const { repoPath, base, head } = await buildRepo("PR-01.patch");
    const app = createServer(db, {
      workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wte-")),
      home: mkdtempSync(join(tmpdir(), "rw-srv-homee-")),
      reviewer: () =>
        Promise.resolve({
          findings: [
            { file: "src/lib/money.ts", startLine: 1, endLine: 2, severity: "medium", category: "quality", note: "comment style" },
            { file: "src/lib/money.ts", startLine: 99, endLine: 100, severity: "low", category: "quality", note: "ghost" },
          ],
        }),
      explainer: (input) =>
        Promise.resolve({ summary: "One sentence.", what_changed: ["x"], who_is_affected: [input.routeId], risks: [], confidence: "high" }),
      summarizer: (input) =>
        Promise.resolve({ title: "t", body: "b", observed_impact: input.exercised, unverified: input.unexercisedImpacted }),
    });
    const runId = "seeded-f01";
    db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, prediction, score, createdAt) VALUES (?, ?, ?, ?, 'ready', '{}', 1, '{}', '{}', '')").run(
      runId,
      repoPath,
      base,
      head,
    );
    const { putArtifact } = await import("./store.js");
    putArtifact(db, runId, "inputs", { repoPath, baseRef: base, headRef: head });
    putArtifact(db, runId, "fused", [
      { routeId: "route:POST /checkout", status: "CONFIRMED", exercised: true, observedChanged: true, staticImpacted: true, inDiff: true, surprise: false, contradictedBy: [] },
      { routeId: "route:GET /reports/sales", status: "UNVERIFIED", exercised: false, observedChanged: false, staticImpacted: true, inDiff: false, surprise: false, contradictedBy: [] },
    ]);
    putArtifact(db, runId, "routeDiffs", [{ routeId: "route:POST /checkout", diffs: [{ path: "$.total", before: 1, after: 2 }] }]);

    expect((await request(app).post(`/api/runs/${runId}/ai-review`).send({})).status).toBe(423);
    const f = await request(app).post(`/api/runs/${runId}/findings`).send({ findings: [{ file: "a", startLine: 1, endLine: 1, note: "mine" }] });
    expect(f.status).toBe(200);
    const ar = await request(app).post(`/api/runs/${runId}/ai-review`).send({});
    expect(ar.status).toBe(200);
    expect((ar.body as { valid: unknown[]; rejected: unknown[] }).valid).toHaveLength(1);
    expect((ar.body as { valid: unknown[]; rejected: unknown[] }).rejected).toHaveLength(1);

    const ex = await request(app).post(`/api/runs/${runId}/explain`).send({ routeId: "route:POST /checkout" });
    expect(ex.status).toBe(200);
    expect((await request(app).post(`/api/runs/${runId}/explain`).send({ routeId: "route:NOPE" })).status).toBe(404);

    const su = await request(app).post(`/api/runs/${runId}/summary`).send({});
    expect(su.status).toBe(200);
    expect((su.body as { summary: { unverified: string[] } }).summary.unverified).toContain("route:GET /reports/sales");
    db.close();
  });

  it("crashing head degrades to static-only with the gate disabled", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-b.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wtb-")), home: mkdtempSync(join(tmpdir(), "rw-srv-homeb-")) });
    const { repoPath, base } = await buildRepo(null);
    await exec("git", ["checkout", "-qb", "broken"], { cwd: repoPath });
    writeFileSync(join(repoPath, "src", "server.ts"), "process.exit(1);\n");
    await exec("git", ["add", "-A"], { cwd: repoPath });
    await exec("git", ["commit", "-qm", "broken"], { cwd: repoPath });
    const broken = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    const started = await request(app)
      .post("/api/analyze")
      .send({ repoPath, baseRef: base, headRef: broken, scenariosDir: subset(["health"]), flakeGuard: false });
    const runId = (started.body as { runId: string }).runId;
    let status = "";
    for (let i = 0; i < 60; i++) {
      const r = await request(app).get(`/api/runs/${runId}/status`);
      status = (r.body as { status: string }).status;
      if (status !== "running") break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    expect(status).toBe("static-only");
    const lock = await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: true });
    expect(lock.status).toBe(409);
    db.close();
  });

  it("per-run gate from analyze overrides the server default at predict", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-g.db`));
    const app = createServer(db, {
      workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wtg-")),
      home: mkdtempSync(join(tmpdir(), "rw-srv-homeg-")),
      gate: { minRecall: 0, minPrecision: 0 },
    });
    const { getArtifact, putArtifact } = await import("./store.js");
    const fused = [
      { routeId: "route:GET /x", status: "SURPRISE", exercised: true, observedChanged: true, staticImpacted: false, inDiff: false, surprise: true, contradictedBy: [] },
    ];
    const seedReady = (runId: string): void => {
      db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, 'r', 'b', 'h', 'ready', '{}', 0, '')").run(runId);
      putArtifact(db, runId, "fused", fused);
    };
    const readScore = (runId: string): { passed: boolean; passReason: string } =>
      JSON.parse((db.prepare("SELECT score FROM runs WHERE id = ?").get(runId) as { score: string }).score) as {
        passed: boolean;
        passReason: string;
      };
    // Strict per-run gate: empty prediction against one observed route fails.
    seedReady("seeded-gate-strict");
    putArtifact(db, "seeded-gate-strict", "gate", { minRecall: 1, minPrecision: 1 });
    expect(
      (await request(app).post("/api/runs/seeded-gate-strict/predict").send({ routeIds: [], nothingElse: false })).status,
    ).toBe(200);
    expect(readScore("seeded-gate-strict")).toMatchObject({ passed: false, passReason: "thresholds_missed" });
    // No per-run gate: lax server default ({0,0}) applies to identical evidence.
    seedReady("seeded-gate-fallback");
    expect(
      (await request(app).post("/api/runs/seeded-gate-fallback/predict").send({ routeIds: [], nothingElse: false })).status,
    ).toBe(200);
    expect(readScore("seeded-gate-fallback")).toMatchObject({ passed: true, passReason: "thresholds_met" });
    // Analyze validates the gate field: out-of-range rejected, valid stored.
    const bad = await request(app)
      .post("/api/analyze")
      .send({ repoPath: "/none", baseRef: "b", headRef: "h", scenariosDir: "/none", gate: { minRecall: 2, minPrecision: 0 } });
    expect(bad.status).toBe(400);
    const good = await request(app)
      .post("/api/analyze")
      .send({ repoPath: "/nonexistent", baseRef: "b", headRef: "h", scenariosDir: "/nonexistent", gate: { minRecall: 1, minPrecision: 0.5 } });
    expect(good.status).toBe(202);
    expect(getArtifact(db, (good.body as { runId: string }).runId, "gate")).toEqual({ minRecall: 1, minPrecision: 0.5 });
    // Settle the background analysis (fails fast on /nonexistent) before close.
    for (let i = 0; i < 50; i++) {
      const r = await request(app).get(`/api/runs/${(good.body as { runId: string }).runId}/status`);
      if ((r.body as { status: string }).status !== "running") break;
      await new Promise((r2) => setTimeout(r2, 200));
    }
    db.close();
  });
});
