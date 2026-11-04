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
const SHOPPY = join(ROOT, "demo", "shop-api-py");
const SCENPY = join(ROOT, "demo", "scenarios-py");

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

  it("new routes are fused DIFF via the base-graph comparison (PR-03)", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wt-")), home: mkdtempSync(join(tmpdir(), "rw-srv-home-")) });
    const { repoPath, base, head } = await buildRepo("PR-03.patch");
    const started = await request(app)
      .post("/api/analyze")
      .send({ repoPath, baseRef: base, headRef: head, scenariosDir: subset(["discounts"]), flakeGuard: false });
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
    await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: false });
    const reveal = await request(app).get(`/api/runs/${runId}/reveal`);
    const nodes = (reveal.body as { nodes: { routeId: string; status: string; isNew?: boolean; inDiff: boolean }[] }).nodes;
    const added = nodes.find((n) => n.routeId === "route:POST /discounts/validate");
    expect(added?.status).toBe("DIFF");
    expect(added?.isNew).toBe(true);
    // Pre-existing routes keep their identity and real in-diff flags.
    const checkout = nodes.find((n) => n.routeId === "route:POST /checkout");
    expect(checkout?.isNew).toBe(false);
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
    // K-06: full-mode ready run issues an L3 receipt (no artifacts declared).
    expect((rc.body as { receipt: { payload: { assuranceTier: string; artifactHashes: unknown } } }).receipt.payload.assuranceTier).toBe("L3");
    expect((rc.body as { receipt: { payload: { assuranceTier: string; artifactHashes: unknown } } }).receipt.payload.artifactHashes).toEqual({});
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

  it("IT-GR-PY-05: python subject with no static routes runs DYNAMIC-ONLY", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-dyn.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wtdyn-")), home: mkdtempSync(join(tmpdir(), "rw-srv-homedyn-")) });
    // No-decorator python HTTP subject: manual dispatch, so the static pass
    // finds zero routes. Serves __routes with one never-hit extra id.
    const repoPath = mkdtempSync(join(tmpdir(), "rw-dyn-"));
    const git = (args: string[]): Promise<string> =>
      exec("git", args, { cwd: repoPath }).then((r) => r.stdout.trim()) as Promise<string>;
    await git(["init", "-q", "-b", "main", "."]);
    await git(["config", "user.email", "t@local"]);
    await git(["config", "user.name", "t"]);
    writeFileSync(
      join(repoPath, "server.py"),
      `import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

class H(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            return self._send(200, {"ok": True})
        if p == "/ping":
            return self._send(200, {"pong": True})
        if p == "/__routes":
            return self._send(200, {"routes": ["route:GET /ping", "route:GET /v1/extra"]})
        return self._send(404, {"error": "not_found"})
    def log_message(self, *args):
        pass

ThreadingHTTPServer(("127.0.0.1", int(os.environ["PORT"])), H).serve_forever()
`,
    );
    writeFileSync(join(repoPath, "requirements.txt"), "# none\n");
    writeFileSync(join(repoPath, ".gitignore"), "__pycache__\n.venv\n");
    const { default: Database } = await import("better-sqlite3");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repoPath, "seed"), { recursive: true });
    new Database(join(repoPath, "seed", "seed.db")).close();
    await git(["add", "-A"]);
    await git(["commit", "-qm", "base"]);
    const base = await git(["rev-parse", "HEAD"]);
    const scenariosDir = mkdtempSync(join(tmpdir(), "rw-dyn-scen-"));
    writeFileSync(
      join(scenariosDir, "ping.json"),
      JSON.stringify({ id: "ping", group: "g", routeIds: ["route:GET /ping"], steps: [{ method: "GET", path: "/ping" }] }),
    );
    const started = await request(app).post("/api/analyze").send({
      repoPath,
      baseRef: base,
      headRef: base,
      scenariosDir,
      flakeGuard: false,
      language: "python",
      appStart: ["python3", "server.py"],
    });
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
    const st = await request(app).get(`/api/runs/${runId}/status`);
    expect((st.body as { reviewMode: string }).reviewMode).toBe("dynamic-only");
    await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: true });
    const reveal = await request(app).get(`/api/runs/${runId}/reveal`);
    const nodes = (reveal.body as { nodes: { routeId: string; status: string }[] }).nodes;
    expect(nodes.find((n) => n.routeId === "route:GET /ping")?.status).toBe("UNCHANGED");
    // __routes inventory union: never-hit id surfaces as UNCOVERED, not QUIET.
    expect(nodes.find((n) => n.routeId === "route:GET /v1/extra")?.status).toBe("UNCOVERED");
    expect(nodes.some((n) => n.status === "SURPRISE")).toBe(false);
    db.close();
  });

  it("IT-GR-JS-04: node subject with no static routes runs DYNAMIC-ONLY", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-dynjs.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wtdynjs-")), home: mkdtempSync(join(tmpdir(), "rw-srv-homedynjs-")) });
    // Manual-dispatch node HTTP subject: no route registrations at all, so
    // the static pass finds zero routes (the json-server failure shape).
    const repoPath = mkdtempSync(join(tmpdir(), "rw-dynjs-"));
    const git = (args: string[]): Promise<string> =>
      exec("git", args, { cwd: repoPath }).then((r) => r.stdout.trim()) as Promise<string>;
    await git(["init", "-q", "-b", "main", "."]);
    await git(["config", "user.email", "t@local"]);
    await git(["config", "user.name", "t"]);
    writeFileSync(
      join(repoPath, "server.js"),
      `const http = require("node:http");
const server = http.createServer((req, res) => {
  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const p = req.url.split("?")[0];
  if (p === "/health") return send(200, { ok: true });
  if (p === "/ping") return send(200, { pong: true });
  if (p === "/__routes") return send(200, { routes: ["route:GET /ping", "route:GET /v1/extra"] });
  return send(404, { error: "not_found" });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
    );
    const { default: Database } = await import("better-sqlite3");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repoPath, "seed"), { recursive: true });
    new Database(join(repoPath, "seed", "seed.db")).close();
    await git(["add", "-A"]);
    await git(["commit", "-qm", "base"]);
    const base = await git(["rev-parse", "HEAD"]);
    const scenariosDir = mkdtempSync(join(tmpdir(), "rw-dynjs-scen-"));
    writeFileSync(
      join(scenariosDir, "ping.json"),
      JSON.stringify({ id: "ping", group: "g", routeIds: ["route:GET /ping"], steps: [{ method: "GET", path: "/ping" }] }),
    );
    const started = await request(app).post("/api/analyze").send({
      repoPath,
      baseRef: base,
      headRef: base,
      scenariosDir,
      flakeGuard: false,
      language: "node",
      appStart: ["node", "server.js"],
    });
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
    const st = await request(app).get(`/api/runs/${runId}/status`);
    expect((st.body as { reviewMode: string }).reviewMode).toBe("dynamic-only");
    await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: true });
    const reveal = await request(app).get(`/api/runs/${runId}/reveal`);
    const nodes = (reveal.body as { nodes: { routeId: string; status: string }[] }).nodes;
    expect(nodes.find((n) => n.routeId === "route:GET /ping")?.status).toBe("UNCHANGED");
    expect(nodes.find((n) => n.routeId === "route:GET /v1/extra")?.status).toBe("UNCOVERED");
    expect(nodes.some((n) => n.status === "SURPRISE")).toBe(false);
    db.close();
  });

  it("CT-HRV-E2E: harvest adopts the subject suite's deterministic calls", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-hrv.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wthrv-")), home: mkdtempSync(join(tmpdir(), "rw-srv-homehrv-")) });
    const repoPath = mkdtempSync(join(tmpdir(), "rw-hrv-"));
    cpSync(SHOPPY, repoPath, { recursive: true, filter: (s) => !s.includes("__pycache__") && !s.includes(".venv") && !s.includes(".git") });
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
    await exec("git", ["config", "user.email", "t@local"], { cwd: repoPath });
    await exec("git", ["config", "user.name", "t"], { cwd: repoPath });
    await exec("git", ["add", "-A"], { cwd: repoPath });
    await exec("git", ["commit", "-qm", "base"], { cwd: repoPath });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    const started = await request(app).post("/api/analyze").send({
      repoPath,
      baseRef: base,
      headRef: base,
      scenariosDir: SCENPY,
      flakeGuard: false,
      language: "python",
      appStart: ["python3", "server.py"],
    });
    expect(started.status).toBe(202);
    const runId = (started.body as { runId: string }).runId;
    let status = "";
    for (let i = 0; i < 180; i++) {
      const r = await request(app).get(`/api/runs/${runId}/status`);
      status = (r.body as { status: string }).status;
      if (status === "ready" || status === "static-only" || status === "failed") break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    expect(status).toBe("ready");
    await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: true });
    const harvested = await request(app).post(`/api/runs/${runId}/harvest`);
    expect(harvested.status).toBe(200);
    expect((harvested.body as { flips: unknown[] }).flips).toEqual([]);
    // All three suite calls are deterministic: adopted as scenarios.
    expect((harvested.body as { kept: string[] }).kept).toHaveLength(3);
    expect((harvested.body as { dropped: unknown[] }).dropped).toEqual([]);
    db.close();
  }, 420000);

  it("CT-FRG-E2E: forge synthesizes OpenAPI candidates and adopts deterministic ones", async () => {
    const db = openStore(join(tmpdir(), `rw-srv-${Date.now()}-frg.db`));
    const app = createServer(db, { workRoot: mkdtempSync(join(tmpdir(), "rw-srv-wtfrg-")), home: mkdtempSync(join(tmpdir(), "rw-srv-homefrg-")) });
    const repoPath = mkdtempSync(join(tmpdir(), "rw-frg-"));
    cpSync(SHOPPY, repoPath, { recursive: true, filter: (s) => !s.includes("__pycache__") && !s.includes(".venv") && !s.includes(".git") });
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
    await exec("git", ["config", "user.email", "t@local"], { cwd: repoPath });
    await exec("git", ["config", "user.name", "t"], { cwd: repoPath });
    await exec("git", ["add", "-A"], { cwd: repoPath });
    await exec("git", ["commit", "-qm", "base"], { cwd: repoPath });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    const started = await request(app).post("/api/analyze").send({
      repoPath,
      baseRef: base,
      headRef: base,
      scenariosDir: SCENPY,
      flakeGuard: false,
      language: "python",
      appStart: ["python3", "server.py"],
    });
    expect(started.status).toBe(202);
    const runId = (started.body as { runId: string }).runId;
    let status = "";
    for (let i = 0; i < 180; i++) {
      const r = await request(app).get(`/api/runs/${runId}/status`);
      status = (r.body as { status: string }).status;
      if (status === "ready" || status === "static-only" || status === "failed") break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    expect(status).toBe("ready");
    await request(app).post(`/api/runs/${runId}/predict`).send({ routeIds: [], nothingElse: true });
    const forged = await request(app).post(`/api/runs/${runId}/forge`);
    expect(forged.status).toBe(200);
    expect((forged.body as { synthesized: number }).synthesized).toBe(11);
    expect((forged.body as { kept: string[] }).kept).toHaveLength(11);
    expect((forged.body as { dropped: unknown[] }).dropped).toEqual([]);
    db.close();
  }, 420000);
});
