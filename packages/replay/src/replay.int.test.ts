import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";
import { buildSubjectRepo, cleanup, subsetScenariosDir } from "./testkit.js";
import { diffSteps } from "./diff.js";
import { createWorktree, removeWorktree } from "./git.js";
import { ensureDeps, hashManifests, pnpmLauncher } from "./deps.js";
import { isPortFree } from "./ports.js";
import { ProcRegistry } from "./proc.js";
import { runReplay } from "./runner.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHOP = join(ROOT, "demo", "shop-api");
const SCEN = join(ROOT, "demo", "scenarios");
const PRS = join(ROOT, "demo", "prs");
const SHOPJS = join(ROOT, "demo", "shop-api-js");
const PRSJS = join(ROOT, "demo", "prs-js");
const SHOPPY = join(ROOT, "demo", "shop-api-py");
const SCENPY = join(ROOT, "demo", "scenarios-py");
const PRSPY = join(ROOT, "demo", "prs-py");
const SHOPGO = join(ROOT, "demo", "shop-api-go");
const SCENGO = join(ROOT, "demo", "scenarios-go");
const PRSGO = join(ROOT, "demo", "prs-go");
const PY_START = ["python3", "server.py"];

const APP_START = [...pnpmLauncher(), "start"];
const tmpRoots: string[] = [];
afterAll(() => {
  for (const p of tmpRoots) cleanup(p);
});
function track(p: string): string {
  tmpRoots.push(p);
  return p;
}

describe("replay integration (C-02/C-03/C-04)", () => {
  it("IT-REP-01: two replays of the same refs yield identical observations", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, []);
    track(subj.repoPath);
    const scenariosDir = track(subsetScenariosDir(SCEN, ["health", "products"], "rep01"));
    const opts = {
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.base,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      appStart: APP_START,
      workRoot: track(join(tmpdir(), `rw-work-rep01-${Date.now()}`)),
    };
    const a = await runReplay(opts);
    const b = await runReplay({ ...opts, workRoot: track(join(tmpdir(), `rw-work-rep01b-${Date.now()}`)) });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.base.steps)).toBe(JSON.stringify(b.base.steps));
    expect(a.base.dbHash).toEqual(b.base.dbHash);
  });

  it("IT-REP-02: PR-01 (comment only) shows zero observed changes", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, ["PR-01.patch"]);
    track(subj.repoPath);
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-01"] as string,
      scenariosDir: SCEN,
      seedDbRel: "seed/seed.db",
      appStart: APP_START,
      workRoot: track(join(tmpdir(), `rw-work-rep02-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const changed = r.base.steps.filter((s, i) => {
      const h = r.head.steps[i] as (typeof r.head.steps)[number];
      return diffSteps(s, h).changed;
    });
    expect(changed).toEqual([]);
  });

  it("IT-REP-03: PR-02 (rename helper) shows zero observed changes", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, ["PR-02.patch"]);
    track(subj.repoPath);
    const scenariosDir = track(subsetScenariosDir(SCEN, ["checkout", "shipping", "cart"], "rep03"));
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-02"] as string,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      appStart: APP_START,
      workRoot: track(join(tmpdir(), `rw-work-rep03-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const changed = r.base.steps.filter((s, i) => {
      const h = r.head.steps[i] as (typeof r.head.steps)[number];
      return diffSteps(s, h).changed;
    });
    expect(changed).toEqual([]);
  });

  it("IT-REP-05: groups run on isolated DB copies", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, []);
    track(subj.repoPath);
    const run = async (groups: string[], tag: string) =>
      runReplay({
        repoPath: subj.repoPath,
        baseRef: subj.base,
        headRef: subj.base,
        scenariosDir: track(subsetScenariosDir(SCEN, groups, tag)),
        seedDbRel: "seed/seed.db",
        appStart: APP_START,
        workRoot: track(join(tmpdir(), `rw-work-${tag}-${Date.now()}`)),
      });
    const alone = await run(["reports"], "rep05a");
    const withCheckout = await run(["checkout", "reports"], "rep05b");
    expect(alone.ok).toBe(true);
    expect(withCheckout.ok).toBe(true);
    if (!alone.ok || !withCheckout.ok) return;
    // The checkout group's writes must not leak into the reports group's DB:
    // reports-authed-empty reads identically with and without that group.
    const find = (steps: typeof alone.base.steps): unknown =>
      steps.find((s) => s.scenarioId === "reports-authed-empty")?.body;
    expect(find(alone.base.steps)).toEqual({ total: 4500, orders: 3 });
    expect(find(withCheckout.base.steps)).toEqual(find(alone.base.steps));
  });

  it("IT-REP-06: crashing head fails the stage and releases ports", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, []);
    track(subj.repoPath);
    await execa("git", ["checkout", "-qb", "broken"], { cwd: subj.repoPath });
    writeFileSync(join(subj.repoPath, "src", "server.ts"), "process.exit(1);\n");
    await execa("git", ["add", "-A"], { cwd: subj.repoPath });
    await execa("git", ["commit", "-qm", "broken"], { cwd: subj.repoPath });
    const broken = (await execa("git", ["rev-parse", "HEAD"], { cwd: subj.repoPath })).stdout.trim();
    await execa("git", ["checkout", "-q", "main"], { cwd: subj.repoPath });
    const scenariosDir = track(subsetScenariosDir(SCEN, ["health"], "rep06"));
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: broken,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      appStart: APP_START,
      workRoot: track(join(tmpdir(), `rw-work-rep06-${Date.now()}`)),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.stage).toBe("replay");
    expect(await isPortFree(8101)).toBe(true);
    expect(await isPortFree(8102)).toBe(true);
  });

  it("IT-REP-07: hanging step hits per-step timeout and the run completes", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, []);
    track(subj.repoPath);
    await execa("git", ["checkout", "-qb", "hang"], { cwd: subj.repoPath });
    const appPath = join(subj.repoPath, "src", "app.ts");
    const src = readFileSync(appPath, "utf8");
    const anchor = "\n  return app;";
    expect(src.split(anchor).length - 1).toBe(1);
    writeFileSync(
      appPath,
      src.replace(
        anchor,
        '\n  app.get("/hang", (_req, res) => {\n    setTimeout(() => res.json({ ok: true }), 60000);\n  });\n  return app;',
      ),
    );
    await execa("git", ["add", "-A"], { cwd: subj.repoPath });
    await execa("git", ["commit", "-qm", "hang"], { cwd: subj.repoPath });
    const hang = (await execa("git", ["rev-parse", "HEAD"], { cwd: subj.repoPath })).stdout.trim();
    await execa("git", ["checkout", "-q", "main"], { cwd: subj.repoPath });
    const scenariosDir = track(mkdtempSync(join(tmpdir(), "rw-scen-hang-")));
    writeFileSync(
      join(scenariosDir, "hang.json"),
      JSON.stringify({ id: "hang", group: "hang", routeIds: [], steps: [{ method: "GET", path: "/hang" }] }),
    );
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: hang,
      headRef: hang,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      appStart: APP_START,
      stepTimeoutMs: 2000,
      workRoot: track(join(tmpdir(), `rw-work-rep07-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.base.steps).toHaveLength(1);
    expect(r.base.steps[0]).toMatchObject({ status: 0, body: { error: "step_timeout" } });
  });

  it("IT-REP-08: occupied preferred port falls back without failure", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, []);
    track(subj.repoPath);
    const scenariosDir = track(subsetScenariosDir(SCEN, ["health"], "rep08"));
    const squat: ReturnType<typeof createServer> = createServer();
    await new Promise<void>((resolve) => squat.listen(8101, "127.0.0.1", () => resolve()));
    try {
      const r = await runReplay({
        repoPath: subj.repoPath,
        baseRef: subj.base,
        headRef: subj.base,
        scenariosDir,
        seedDbRel: "seed/seed.db",
        appStart: APP_START,
        ports: { base: 8101, head: 8102 },
        workRoot: track(join(tmpdir(), `rw-work-rep08-${Date.now()}`)),
      });
      expect(r.ok).toBe(true);
    } finally {
      await new Promise((resolve) => squat.close(() => resolve(undefined)));
    }
  });

  it("IT-REP-09: 20 worktree + process lifecycles leave no residue", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, []);
    track(subj.repoPath);
    const procs = new ProcRegistry();
    for (let i = 0; i < 20; i++) {
      const wt = join(tmpdir(), `rw-soak-${Date.now()}-${i}`);
      await createWorktree(subj.repoPath, subj.base, wt);
      const child = procs.spawn("node", ["-e", "setTimeout(()=>{},30000)"], wt, {
        PATH: process.env.PATH as string,
      });
      expect(child.pid).toBeDefined();
      await procs.killAll();
      await removeWorktree(subj.repoPath, wt);
    }
    expect(procs.size).toBe(0);
    const list = (await execa("git", ["worktree", "list", "--porcelain"], { cwd: subj.repoPath })).stdout;
    expect(list.split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  it("IT-REP-10: unchanged manifests symlink, changed manifests install", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, []);
    track(subj.repoPath);
    const wtSame = join(tmpdir(), `rw-dep-same-${Date.now()}`);
    await createWorktree(subj.repoPath, subj.base, wtSame);
    try {
      const h = hashManifests(subj.repoPath);
      const r1 = await ensureDeps(SHOP, wtSame, h, h);
      expect(r1.strategy).toBe("symlink");
    } finally {
      await removeWorktree(subj.repoPath, wtSame);
    }
    // Changed manifests on a zero-dep fixture app: exercises the install path fast.
    const tiny = track(mkdtempSync(join(tmpdir(), "rw-dep-tiny-")));
    writeFileSync(join(tiny, "package.json"), JSON.stringify({ name: "tiny", private: true }));
    await execa("corepack", ["pnpm", "install", "--lockfile-only"], { cwd: tiny });
    const wtTiny = track(mkdtempSync(join(tmpdir(), "rw-dep-tinywt-")));
    writeFileSync(
      join(wtTiny, "package.json"),
      JSON.stringify({ name: "tiny", private: true, version: "0.0.1" }),
    );
    await execa("cp", [join(tiny, "pnpm-lock.yaml"), join(wtTiny, "pnpm-lock.yaml")]);
    const r2 = await ensureDeps(tiny, wtTiny, "aaa", "bbb");
    expect(r2.strategy).toBe("install");
  });

  it("PERF-01 + PR-00 sanity: full suite under 120s with real checkout/reports diffs", async () => {
    const subj = await buildSubjectRepo(SHOP, PRS, ["PR-00.patch"]);
    track(subj.repoPath);
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-00"] as string,
      scenariosDir: SCEN,
      seedDbRel: "seed/seed.db",
      appStart: APP_START,
      workRoot: track(join(tmpdir(), `rw-work-perf-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    console.log(`PERF-01 full-suite replay: ${(r.elapsedMs / 1000).toFixed(1)}s (target <=60s, hard 120s)`);
    expect(r.elapsedMs).toBeLessThan(120000);
    const changedByScenario = new Set<string>();
    r.base.steps.forEach((s, i) => {
      const h = r.head.steps[i] as (typeof r.head.steps)[number];
      if (diffSteps(s, h).changed) changedByScenario.add(s.scenarioId);
    });
    expect(changedByScenario.has("checkout-vip")).toBe(true);
    expect(changedByScenario.has("reports-after-checkout")).toBe(true);
  });
});

describe("pytest harvesting (F-24)", () => {
  it("CT-HRV-LIVE: runHarvest parses outcomes and captured calls", async () => {
    // Provision pytest in a scratch venv; skip with reason when offline.
    const venv = track(mkdtempSync(join(tmpdir(), "rw-harv-venv-")));
    try {
      await execa("python3", ["-m", "venv", join(venv, "env")], { timeout: 120000 });
      await execa(join(venv, "env", "bin", "pip"), ["install", "--disable-pip-version-check", "pytest"], { timeout: 180000 });
    } catch {
      console.log("CT-HRV-LIVE skipped: cannot provision pytest (offline?)");
      return;
    }
    const proj = track(mkdtempSync(join(tmpdir(), "rw-harv-proj-")));
    writeFileSync(
      join(proj, "test_sample.py"),
      `import http.client

def test_call():
    c = http.client.HTTPConnection("127.0.0.1", 9)
    try:
        c.request("GET", "/items/1", headers={"authorization": "Bearer x"})
    except OSError:
        pass

def test_fail():
    assert False
`,
    );
    const { runHarvest } = await import("./harvest.js");
    const r = await runHarvest(proj, { python: join(venv, "env", "bin", "python"), timeoutMs: 120000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.tests).toEqual([
      { id: "test_sample.py::test_call", outcome: "passed" },
      { id: "test_sample.py::test_fail", outcome: "failed" },
    ]);
    expect(r.result.calls).toHaveLength(1);
    expect(r.result.calls[0]).toMatchObject({ test: "test_sample.py::test_call", method: "GET" });
    expect(r.result.calls[0]?.url).toContain("/items/1");
    expect(r.result.calls[0]?.headers).not.toHaveProperty("authorization");
  }, 240000);
});

describe("compute scenarios (F-23)", () => {
  const MLIB_BASE = `class Token:
    def __init__(self, v):
        self.v = v


FACTOR = 2


def score(x):
    return {"y": x * FACTOR}


def boom(x):
    if x < 0:
        raise ValueError("kaput")
    return x


def tokenize(x):
    return Token(x)
`;

  async function buildLibRepo(): Promise<{ repoPath: string; base: string; head: string; scenariosDir: string }> {
    const repoPath = track(mkdtempSync(join(tmpdir(), "rw-compute-")));
    const git = (args: string[]): Promise<string> =>
      execa("git", args, { cwd: repoPath }).then((r) => r.stdout.trim()) as Promise<string>;
    await git(["init", "-q", "-b", "main", "."]);
    await git(["config", "user.email", "t@local"]);
    await git(["config", "user.name", "t"]);
    writeFileSync(join(repoPath, "mlib.py"), MLIB_BASE);
    writeFileSync(join(repoPath, ".gitignore"), "__pycache__\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "base"]);
    const base = await git(["rev-parse", "HEAD"]);
    await git(["checkout", "-qb", "head"]);
    writeFileSync(join(repoPath, "mlib.py"), MLIB_BASE.replace("FACTOR = 2", "FACTOR = 3"));
    await git(["add", "-A"]);
    await git(["commit", "-qm", "head"]);
    const head = await git(["rev-parse", "HEAD"]);
    const scenariosDir = track(mkdtempSync(join(tmpdir(), "rw-compute-scen-")));
    const scen = (id: string, target: string, args: unknown[], route: string): void => {
      writeFileSync(
        join(scenariosDir, `${id}.json`),
        JSON.stringify({ id, group: "ml", kind: "compute", target, args, routeIds: [route] }),
      );
    };
    scen("compute-score", "mlib:score", [2], "fn:mlib:score");
    scen("compute-boom", "mlib:boom", [-1], "fn:mlib:boom");
    scen("compute-token", "mlib:tokenize", ["a"], "fn:mlib:tokenize");
    return { repoPath, base, head, scenariosDir };
  }

  it("CT-CMP-01: pure-function outputs diff and attribute to fn: ids", async () => {
    const lib = await buildLibRepo();
    const r = await runReplay({
      repoPath: lib.repoPath,
      baseRef: lib.base,
      headRef: lib.head,
      scenariosDir: lib.scenariosDir,
      seedDbRel: "seed/seed.db",
      language: "python",
      workRoot: track(join(tmpdir(), `rw-work-cmp-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.base.steps).toHaveLength(3);
    const byId = new Map(r.base.steps.map((s, i) => [s.scenarioId, { s, h: r.head.steps[i] as (typeof r.head.steps)[number] }]));
    const score = byId.get("compute-score") as { s: (typeof r.base.steps)[number]; h: (typeof r.head.steps)[number] };
    expect(score.s.body).toEqual({ y: 4 });
    expect(score.h.body).toEqual({ y: 6 });
    expect(diffSteps(score.s, score.h).changed).toBe(true);
    expect(score.s.method).toBe("CALL");
    expect(score.s.path).toBe("fn:mlib:score");
  });

  it("CT-CMP-02: head-only raise is a typed error observation; the run completes", async () => {
    const lib = await buildLibRepo();
    const r = await runReplay({
      repoPath: lib.repoPath,
      baseRef: lib.base,
      headRef: lib.head,
      scenariosDir: lib.scenariosDir,
      seedDbRel: "seed/seed.db",
      language: "python",
      workRoot: track(join(tmpdir(), `rw-work-cmp2-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const boom = r.base.steps.find((s) => s.scenarioId === "compute-boom") as (typeof r.base.steps)[number];
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).toContain("ValueError");
  });

  it("IT-REP-11: python subject replays; PR-PY-00 ripple observed on reports", async () => {
    const subj = await buildSubjectRepo(SHOPPY, PRSPY, ["PR-PY-00.patch"]);
    track(subj.repoPath);
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-PY-00"] as string,
      scenariosDir: SCENPY,
      seedDbRel: "seed/seed.db",
      language: "python",
      appStart: PY_START,
      workRoot: track(join(tmpdir(), `rw-work-rep11-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Python lifecycle strategies: requirements -> venv install, else none.
    const { ensureDeps } = await import("./deps.js");
    const { existsSync } = await import("node:fs");
    const withReq = track(mkdtempSync(join(tmpdir(), "rw-pydeps-")));
    writeFileSync(join(withReq, "requirements.txt"), "# none\n");
    const installed = await ensureDeps(withReq, withReq, "a", "a", { language: "python" });
    expect(installed.strategy).toBe("install");
    expect(existsSync(join(withReq, ".venv", "bin", "python"))).toBe(true);
    const bare = track(mkdtempSync(join(tmpdir(), "rw-pydeps-bare-")));
    expect((await ensureDeps(bare, bare, "a", "a", { language: "python" })).strategy).toBe("none");
    const changed = new Set<string>();
    r.base.steps.forEach((s, i) => {
      if (diffSteps(s, r.head.steps[i] as (typeof r.head.steps)[number]).changed) changed.add(s.scenarioId);
    });
    expect(changed.has("reports-after-checkout")).toBe(true);
    expect(changed.has("checkout-flow")).toBe(true);
    expect(changed.has("health-ok")).toBe(false);
  });

  it("IT-REP-12: JS subject replays with package.json start discovery (no appStart)", async () => {
    const subj = await buildSubjectRepo(SHOPJS, PRSJS, ["PR-JS-00.patch"]);
    track(subj.repoPath);
    const scenariosDir = track(subsetScenariosDir(SCEN, ["checkout", "reports"], "rep12"));
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-JS-00"] as string,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      workRoot: track(join(tmpdir(), `rw-work-rep12-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const changed = new Set<string>();
    r.base.steps.forEach((s, i) => {
      if (diffSteps(s, r.head.steps[i] as (typeof r.head.steps)[number]).changed) changed.add(s.scenarioId);
    });
    expect(changed.has("reports-after-checkout")).toBe(true);
  });

  it("IT-REP-13: direct Date.now/Math.random use is frozen by interposition", async () => {
    const repoPath = track(mkdtempSync(join(tmpdir(), "rw-noisy-")));
    const git = (args: string[]): Promise<string> =>
      execa("git", args, { cwd: repoPath }).then((x) => x.stdout.trim()) as Promise<string>;
    await git(["init", "-q", "-b", "main", "."]);
    await git(["config", "user.email", "t@local"]);
    await git(["config", "user.name", "t"]);
    writeFileSync(
      join(repoPath, "server.js"),
      `import http from "node:http";
const srv = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end(JSON.stringify({ ok: true }));
  res.end(JSON.stringify({ at: Date.now(), r: Math.random() }));
});
srv.listen(Number(process.env.PORT), "127.0.0.1");\n`,
    );
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "noisy", type: "module", scripts: { start: "node server.js" } }));
    writeFileSync(join(repoPath, ".gitignore"), "node_modules\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "base"]);
    const base = await git(["rev-parse", "HEAD"]);
    const scenariosDir = track(mkdtempSync(join(tmpdir(), "rw-noisy-scen-")));
    writeFileSync(
      join(scenariosDir, "noisy.json"),
      JSON.stringify({ id: "noisy", group: "g", routeIds: ["route:GET /"], steps: [{ method: "GET", path: "/" }] }),
    );
    const opts = {
      repoPath,
      baseRef: base,
      headRef: base,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      workRoot: track(join(tmpdir(), `rw-work-rep13-${Date.now()}`)),
    };
    // Seed DB required for HTTP replay even though the app ignores it.
    const { mkdirSync } = await import("node:fs");
    const { default: Database } = await import("better-sqlite3");
    mkdirSync(join(repoPath, "seed"), { recursive: true });
    new Database(join(repoPath, "seed", "seed.db")).close();
    await git(["add", "-A"]);
    await git(["commit", "-qm", "seed"]);
    const withSeed = await git(["rev-parse", "HEAD"]);
    const a = await runReplay({ ...opts, baseRef: withSeed, headRef: withSeed });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = await runReplay({ ...opts, baseRef: withSeed, headRef: withSeed, workRoot: track(join(tmpdir(), `rw-work-rep13b-${Date.now()}`)) });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(JSON.stringify(a.base.steps)).toBe(JSON.stringify(b.base.steps));
    expect((a.base.steps[0]?.body as { at: number }).at).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("IT-REP-14: tolerated micro-change hides, macro-change shows (python ML)", async () => {
    const subj = await buildSubjectRepo(SHOPPY, PRSPY, ["PR-PY-01.patch", "PR-PY-02.patch"]);
    track(subj.repoPath);
    const scenariosDir = track(subsetScenariosDir(SCENPY, ["ml"], "rep14"));
    const { loadScenarios } = await import("./runner.js");
    const tolerances = loadScenarios(scenariosDir).find((s) => s.id === "predict-basic")?.tolerances ?? [];
    const micro = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-PY-01"] as string,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      language: "python",
      appStart: PY_START,
      workRoot: track(join(tmpdir(), `rw-work-rep14a-${Date.now()}`)),
    });
    expect(micro.ok).toBe(true);
    if (!micro.ok) return;
    const md = diffSteps(micro.base.steps[0] as (typeof micro.base.steps)[number], micro.head.steps[0] as (typeof micro.head.steps)[number], { tolerances });
    expect(md.changed).toBe(false);
    expect(md.tolerated.map((t) => t.path)).toEqual(["$.y"]);
    const macro = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-PY-02"] as string,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      language: "python",
      appStart: PY_START,
      workRoot: track(join(tmpdir(), `rw-work-rep14b-${Date.now()}`)),
    });
    expect(macro.ok).toBe(true);
    if (!macro.ok) return;
    const gd = diffSteps(macro.base.steps[0] as (typeof macro.base.steps)[number], macro.head.steps[0] as (typeof macro.head.steps)[number], { tolerances });
    expect(gd.changed).toBe(true);
  });

  it("CT-CMP-03: non-serializable returns become typed observations, never a runner crash", async () => {
    const lib = await buildLibRepo();
    const r = await runReplay({
      repoPath: lib.repoPath,
      baseRef: lib.base,
      headRef: lib.head,
      scenariosDir: lib.scenariosDir,
      seedDbRel: "seed/seed.db",
      language: "python",
      workRoot: track(join(tmpdir(), `rw-work-cmp3-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tok = r.base.steps.find((s) => s.scenarioId === "compute-token") as (typeof r.base.steps)[number];
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ __type__: "Token" });
  });

  it("IT-REP-GO-01: go subject replays via discovered `go run`; PR-GO-00 ripple on cart+reports", async () => {
    try {
      await execa("go", ["version"]);
    } catch {
      console.log("IT-REP-GO-01 skipped: go toolchain not on PATH");
      return;
    }
    const subj = await buildSubjectRepo(SHOPGO, PRSGO, ["PR-GO-00.patch"]);
    track(subj.repoPath);
    const r = await runReplay({
      repoPath: subj.repoPath,
      baseRef: subj.base,
      headRef: subj.heads["PR-GO-00"] as string,
      scenariosDir: SCENGO,
      seedDbRel: "seed/seed.db",
      language: "go",
      // No appStart: discovery must yield `go run .`. Generous health budget:
      // the first cold compile in a fresh GOCACHE is slow, later boots are warm.
      healthTimeoutMs: 90000,
      workRoot: track(join(tmpdir(), `rw-work-repgo1-${Date.now()}`)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const changed = new Set<string>();
    r.base.steps.forEach((s, i) => {
      if (diffSteps(s, r.head.steps[i] as (typeof r.head.steps)[number]).changed) changed.add(s.scenarioId);
    });
    expect(changed.has("cart-add")).toBe(true);
    expect(changed.has("reports-after-cart")).toBe(true);
    expect(changed.has("health-ok")).toBe(false);
  });
});
