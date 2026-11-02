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
import { ensureDeps, hashManifests } from "./deps.js";
import { isPortFree } from "./ports.js";
import { ProcRegistry } from "./proc.js";
import { runReplay } from "./runner.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHOP = join(ROOT, "demo", "shop-api");
const SCEN = join(ROOT, "demo", "scenarios");
const PRS = join(ROOT, "demo", "prs");

const APP_START = ["corepack", "pnpm", "start"];
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
