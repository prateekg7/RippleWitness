import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { z } from "zod";
import { createWorktree, removeWorktree } from "./git.js";
import { discoverGoStartCommand, discoverStartCommand, ensureDeps, hashManifests, pnpmLauncher } from "./deps.js";
import { isPortFree, resolvePort } from "./ports.js";
import { ProcRegistry } from "./proc.js";
import { hashDb } from "./dbhash.js";
import { scrubEnv, unsetProxies } from "./sandbox.js";
import type { ReplayOptions, ReplayResult, SideResult, StepObservation } from "./types.js";

const StepSchema = z.object({
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  capture: z.record(z.string()).optional(),
});
const ToleranceSchema = z.object({
  path: z.string().min(1),
  rtol: z.number().nonnegative().optional(),
  atol: z.number().nonnegative().optional(),
  nanEqual: z.boolean().optional(),
});
const ScenarioSchema = z
  .object({
    id: z.string(),
    group: z.string(),
    routeIds: z.array(z.string()),
    steps: z.array(StepSchema).optional(),
    tolerances: z.array(ToleranceSchema).optional(),
    /** Compute scenarios (F-23): call `target` with fixtures instead of HTTP. */
    kind: z.enum(["http", "compute"]).optional(),
    target: z.string().optional(),
    args: z.array(z.unknown()).optional(),
    kwargs: z.record(z.unknown()).optional(),
  })
  .superRefine((s, ctx) => {
    if ((s.kind ?? "http") === "compute") {
      if (!s.target) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compute scenario requires target" });
    } else if (!s.steps || s.steps.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "http scenario requires steps" });
    }
  });
type Scenario = z.infer<typeof ScenarioSchema>;

const HEADER_SUBSET = ["content-type", "cache-control", "location"];

function getPath(obj: unknown, expr: string): unknown {
  if (!expr.startsWith("$.")) throw new Error(`unsupported capture expr: ${expr}`);
  let cur: unknown = obj;
  for (const key of expr.slice(2).split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function subst(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`unbound template {{${key}}}`);
    return String(vars[key]);
  });
}

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort()
    .map((f) => ScenarioSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

async function waitHealth(port: number, timeoutMs: number, childExited: () => boolean): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (childExited()) {
      throw new Error(
        `app exited before health check passed on :${port} (see IT-REP-06; if EPERM on listen, the sandbox blocks localhost servers — S-03)`,
      );
    }
    if (Date.now() - started > timeoutMs) throw new Error(`health timeout on :${port} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runStep(
  base: string,
  scenarioId: string,
  stepIndex: number,
  step: z.infer<typeof StepSchema>,
  vars: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ obs: StepObservation; vars: Record<string, unknown> }> {
  const path = subst(step.path, vars);
  const bodyText = step.body === undefined ? undefined : subst(JSON.stringify(step.body), vars);
  try {
    const res = await fetch(`${base}${path}`, {
      method: step.method,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
      ...(bodyText === undefined ? {} : { body: bodyText }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep raw text (e.g. Express HTML 404) */
    }
    const headers: Record<string, string> = {};
    for (const h of HEADER_SUBSET) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    const next = { ...vars };
    if (step.capture) {
      for (const [key, expr] of Object.entries(step.capture)) next[key] = getPath(parsed, expr);
    }
    return { obs: { scenarioId, stepIndex, method: step.method, path, status: res.status, body: parsed, headers }, vars: next };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return {
        obs: { scenarioId, stepIndex, method: step.method, path, status: 0, body: { error: "step_timeout" }, headers: {} },
        vars,
      };
    }
    throw err;
  }
}

export interface SideRun {
  result: SideResult;
  depsStrategy: string;
  port: number;
  portConflict: boolean;
}

/** Run one side (base or head). Exported so the flake guard can run base twice. */
export async function runSide(
  worktreePath: string,
  sourceAppDir: string,
  baseHash: string,
  headHash: string,
  scenarios: Scenario[],
  opts: {
    seedDb: string;
    appStart: string[];
    port: number;
    workRoot: string;
    side: string;
    env?: Record<string, string>;
    stepTimeoutMs: number;
    healthTimeoutMs: number;
    language?: "node" | "python" | "go";
  },
): Promise<SideRun> {
  const language = opts.language ?? "node";
  const { strategy } = await ensureDeps(sourceAppDir, worktreePath, baseHash, headHash, { language });
  if (scenarios.length === 0) {
    // No HTTP scenarios (compute-only side): deps are provisioned, no server to run.
    return { result: { steps: [], dbHash: {}, outbound: [], routes: [] }, depsStrategy: strategy, port: 0, portConflict: false };
  }
  const venvBin = language === "python" ? join(worktreePath, ".venv", "bin") : null;
  const pathEnv = venvBin && existsSync(venvBin) ? `${venvBin}:${process.env.PATH ?? ""}` : (process.env.PATH as string);
  // Determinism interposition (F-22): freeze clocks/seeds from outside the app.
  // Go has no interposition available: Go subjects must avoid wall-clock and
  // map-order nondeterminism (volatile routes are still detected and masked).
  const shimDir = join(dirname(fileURLToPath(import.meta.url)), "..", "shim");
  const interposed =
    language === "python"
      ? { PYTHONHASHSEED: "0", PYTHONPATH: shimDir, CUDA_VISIBLE_DEVICES: "" }
      : language === "go"
        ? {
            // Spawn env is strict (no HOME passthrough): pin Go caches inside
            // the run dir so `go run` works sandboxed and stays hermetic.
            GOCACHE: join(opts.workRoot, "gocache"),
            GOMODCACHE: join(opts.workRoot, "gomodcache"),
            GOPATH: join(opts.workRoot, "gopath"),
            GOPROXY: "off",
          }
        : { NODE_OPTIONS: `--require ${join(shimDir, "freeze-node.cjs")}` };
  const { port, conflict } = await resolvePort(opts.port);
  const groups = [...new Set(scenarios.map((s) => s.group))].sort();
  const steps: StepObservation[] = [];
  const dbHash: Record<string, Record<string, string>> = {};
  const routeSet = new Set<string>();
  let routesCaptured = false;
  const outboundLog = join(opts.workRoot, `outbound-${opts.side}.log`);
  writeFileSync(outboundLog, "");
  const procs = new ProcRegistry();
  try {
    for (const group of groups) {
      const dbPath = join(opts.workRoot, `db-${opts.side}-${group}.sqlite`);
      if (existsSync(dbPath)) rmSync(dbPath);
      copyFileSync(opts.seedDb, dbPath);
      const [cmd, ...args] = opts.appStart;
      const child = procs.spawn(cmd as string, args, worktreePath, {
        PATH: pathEnv,
        NODE_ENV: "test",
        PORT: String(port),
        FROZEN_TIME: "2026-01-01T00:00:00Z",
        SEED: "42",
        DB_PATH: dbPath,
        EXTERNAL_MODE: "mock",
        OUTBOUND_LOG: outboundLog,
        ...interposed,
        ...scrubEnv(opts.env ?? {}),
      }, { captureStderr: true });
      try {
        try {
          await waitHealth(port, opts.healthTimeoutMs, () => child.exitCode !== null);
        } catch (err) {
          // Boot failures must be diagnosable (CI proved they otherwise are not).
          const tail = procs.stderrTail(child).trim().replace(/\s+/g, " ").slice(-500);
          throw new Error(`${(err as Error).message}${tail ? ` — app stderr: ${tail}` : ""}`);
        }
        if (!routesCaptured) {
          routesCaptured = true;
          // Best-effort route inventory for dynamic-only reviews (J-05).
          try {
            const r = await fetch(`http://127.0.0.1:${port}/__routes`, { signal: AbortSignal.timeout(5000) });
            const parsed = z.object({ routes: z.array(z.string()) }).safeParse(await r.json());
            if (r.ok && parsed.success) for (const id of parsed.data.routes) routeSet.add(id);
          } catch {
            // Absent or malformed: inventory falls back to scenario-declared routes.
          }
        }
        for (const s of scenarios.filter((x) => x.group === group)) {
          let vars: Record<string, unknown> = {};
          for (let i = 0; i < (s.steps ?? []).length; i++) {
            const step = (s.steps ?? [])[i] as z.infer<typeof StepSchema>;
            const r = await runStep(`http://127.0.0.1:${port}`, s.id, i, step, vars, opts.stepTimeoutMs);
            vars = r.vars;
            steps.push(r.obs);
          }
        }
      } finally {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      dbHash[group] = hashDb(dbPath);
    }
  } finally {
    await procs.killAll();
  }
  const outbound = readFileSync(outboundLog, "utf8").split("\n").filter((l) => l.length > 0);
  const allRoutes = [...routeSet].sort();
  return { result: { steps, dbHash, outbound, routes: allRoutes }, depsStrategy: strategy, port, portConflict: conflict };
}

/**
 * Run compute scenarios (F-23) for one side: no server — each scenario calls a
 * named function in the worktree via the sandbox runner script. Observations
 * use method "CALL" with the scenario's fn: route id as the path so the
 * standard differ/attribution path applies unchanged.
 */
export async function runComputeSide(
  worktreePath: string,
  scenarios: Scenario[],
  opts: {
    workRoot: string;
    side: string;
    seedDb: string;
    stepTimeoutMs: number;
    env?: Record<string, string>;
    /** Function-call runtime. Default "python" (F-23); "node" serves F-10 on JS/TS subjects. */
    runtime?: "python" | "node";
  },
): Promise<{ steps: StepObservation[]; dbHash: Record<string, Record<string, string>> }> {
  const steps: StepObservation[] = [];
  const dbHash: Record<string, Record<string, string>> = {};
  const shimDir = join(dirname(fileURLToPath(import.meta.url)), "..", "shim");
  const venvBin = join(worktreePath, ".venv", "bin");
  const pathEnv = existsSync(venvBin) ? `${venvBin}:${process.env.PATH ?? ""}` : (process.env.PATH as string);
  const groups = [...new Set(scenarios.map((s) => s.group))].sort();
  for (const group of groups) {
    const dbPath = join(opts.workRoot, `db-${opts.side}-${group}-compute.sqlite`);
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(opts.seedDb)) copyFileSync(opts.seedDb, dbPath);
    for (const s of scenarios.filter((x) => x.group === group)) {
      const target = s.target as string;
      const argFile = join(opts.workRoot, `compute-${opts.side}-${s.id}.json`);
      writeFileSync(argFile, JSON.stringify({ args: s.args ?? [], kwargs: s.kwargs ?? {} }));
      const env = {
        PATH: pathEnv,
        FROZEN_TIME: "2026-01-01T00:00:00Z",
        SEED: "42",
        DB_PATH: dbPath,
        EXTERNAL_MODE: "mock",
        PYTHONHASHSEED: "0",
        PYTHONPATH: shimDir,
        CUDA_VISIBLE_DEVICES: "",
        ...scrubEnv(opts.env ?? {}),
        // execa merges over process.env: explicitly unset inherited proxies.
        ...unsetProxies(),
      };
      let obs: StepObservation;
      try {
        const nodeTarget = opts.runtime === "node";
        const argv = nodeTarget
          ? [join(shimDir, "compute-run.mjs"), target, argFile]
          : [join(shimDir, "compute-run.py"), target, argFile];
        // Type-stripping lets plain TS modules import directly (Node >= 22.6);
        // non-erasable syntax fails inside the envelope, never here.
        const nodeArgs = nodeTarget && /\.tsx?#/.test(target) ? ["--experimental-strip-types", "--no-warnings"] : [];
        const { stdout } = await execa(nodeTarget ? "node" : "python3", [...nodeArgs, ...argv], {
          cwd: worktreePath,
          env,
          // Strict env: subject code must not inherit server secrets
          // (META_API_KEY, keys) the way execa's default env merge would.
          extendEnv: false,
          timeout: opts.stepTimeoutMs,
        });
        const parsed = JSON.parse(stdout) as { ok: boolean; value?: unknown; error?: string };
        obs = {
          scenarioId: s.id,
          stepIndex: 0,
          method: "CALL",
          path: s.routeIds[0] ?? target,
          status: parsed.ok ? 200 : 500,
          body: parsed.ok ? parsed.value : { error: parsed.error ?? "compute_failed" },
          headers: {},
        };
      } catch (err) {
        const timedOut = (err as { timedOut?: boolean }).timedOut === true;
        obs = {
          scenarioId: s.id,
          stepIndex: 0,
          method: "CALL",
          path: s.routeIds[0] ?? target,
          status: 0,
          body: { error: timedOut ? "step_timeout" : `compute_failed: ${String(err).slice(0, 200)}` },
          headers: {},
        };
      }
      steps.push(obs);
    }
    if (existsSync(dbPath)) dbHash[`${group}+compute`] = hashDb(dbPath);
  }
  return { steps, dbHash };
}

/** Full differential replay: base vs head. Never throws across the boundary — returns typed results. */
export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const started = Date.now();
  const workRoot = opts.workRoot ?? join(process.cwd(), ".ripplewitness", "runs", `run-${started}`);
  mkdirSync(workRoot, { recursive: true });
  const appDir = opts.appDir ?? ".";
  const language = opts.language ?? "node";
  let scenarios: Scenario[];
  try {
    scenarios = loadScenarios(opts.scenariosDir);
  } catch (err) {
    return { ok: false, error: { stage: "scenarios", message: String(err) } };
  }
  const httpScenarios = scenarios.filter((s) => (s.kind ?? "http") === "http");
  const computeScenarios = [...scenarios.filter((s) => s.kind === "compute")].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (computeScenarios.length > 0 && language === "go") {
    return { ok: false, error: { stage: "config", message: "compute scenarios need a node or python subject (F-10/F-23)" } };
  }
  const appStart =
    opts.appStart ??
    (language === "node" ? discoverStartCommand(join(opts.repoPath, appDir)) : null) ??
    (language === "go" ? discoverGoStartCommand(join(opts.repoPath, appDir)) : null) ??
    (language === "node" ? [...pnpmLauncher(), "start"] : null);
  if (!appStart && httpScenarios.length > 0) {
    return { ok: false, error: { stage: "config", message: `${language} subjects require an explicit appStart command` } };
  }
  const stepTimeoutMs = opts.stepTimeoutMs ?? 15000;
  const healthTimeoutMs = opts.healthTimeoutMs ?? 15000;
  const baseWt = join(workRoot, "wt-base");
  const headWt = join(workRoot, "wt-head");
  try {
    await createWorktree(opts.repoPath, opts.baseRef, baseWt);
    await createWorktree(opts.repoPath, opts.headRef, headWt);
  } catch (err) {
    return { ok: false, error: { stage: "worktree", message: String(err) } };
  }
  try {
    const sourceAppDir = join(opts.repoPath, appDir);
    const baseAppDir = join(baseWt, appDir);
    const headAppDir = join(headWt, appDir);
    const baseHash = hashManifests(baseAppDir);
    const headHash = hashManifests(headAppDir);
    const seedBase = join(baseAppDir, opts.seedDbRel);
    const seedHead = join(headAppDir, opts.seedDbRel);
    // Seed DB is required for HTTP replay; compute-only subjects (ML libraries)
    // may not have one — their functions get a DB_PATH that may not exist.
    if (httpScenarios.length > 0 && (!existsSync(seedBase) || !existsSync(seedHead))) {
      return { ok: false, error: { stage: "seed", message: `seed DB missing: ${opts.seedDbRel}` } };
    }
    const common = {
      workRoot,
      stepTimeoutMs,
      healthTimeoutMs,
      language,
      ...(opts.env ? { env: opts.env } : {}),
    };
    let base: SideRun;
    let head: SideRun;
    try {
      base = await runSide(baseAppDir, sourceAppDir, baseHash, headHash, httpScenarios, {
        ...common,
        seedDb: seedBase,
        appStart: appStart ?? ["true"],
        port: opts.ports?.base ?? 8101,
        side: "base",
      });
      head = await runSide(headAppDir, sourceAppDir, baseHash, headHash, httpScenarios, {
        ...common,
        seedDb: seedHead,
        appStart: appStart ?? ["true"],
        port: opts.ports?.head ?? 8102,
        side: "head",
      });
      if (computeScenarios.length > 0) {
        const runtime = language === "node" ? "node" : "python";
        const baseCompute = await runComputeSide(baseAppDir, computeScenarios, {
          workRoot,
          side: "base",
          seedDb: seedBase,
          stepTimeoutMs,
          runtime,
          ...(opts.env ? { env: opts.env } : {}),
        });
        const headCompute = await runComputeSide(headAppDir, computeScenarios, {
          workRoot,
          side: "head",
          seedDb: seedHead,
          stepTimeoutMs,
          runtime,
          ...(opts.env ? { env: opts.env } : {}),
        });
        base.result.steps.push(...baseCompute.steps);
        head.result.steps.push(...headCompute.steps);
        base.result.dbHash = { ...base.result.dbHash, ...baseCompute.dbHash };
        head.result.dbHash = { ...head.result.dbHash, ...headCompute.dbHash };
      }
    } catch (err) {
      return { ok: false, error: { stage: "replay", message: String(err) } };
    }
    // Post-condition: ports released (IT-REP-06/09). Port 0 means no server
    // ran on that side (compute-only) — nothing to check.
    for (const p of [base.port, head.port]) {
      if (p === 0) continue;
      if (!(await isPortFree(p))) {
        return { ok: false, error: { stage: "teardown", message: `port ${p} still occupied after teardown` } };
      }
    }
    return { ok: true, base: base.result, head: head.result, elapsedMs: Date.now() - started };
  } finally {
    await removeWorktree(opts.repoPath, baseWt).catch(() => {});
    await removeWorktree(opts.repoPath, headWt).catch(() => {});
  }
}
