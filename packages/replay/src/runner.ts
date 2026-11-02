import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createWorktree, removeWorktree } from "./git.js";
import { ensureDeps, hashManifests } from "./deps.js";
import { isPortFree, resolvePort } from "./ports.js";
import { ProcRegistry } from "./proc.js";
import { hashDb } from "./dbhash.js";
import type { ReplayOptions, ReplayResult, SideResult, StepObservation } from "./types.js";

const StepSchema = z.object({
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  capture: z.record(z.string()).optional(),
});
const ScenarioSchema = z.object({
  id: z.string(),
  group: z.string(),
  routeIds: z.array(z.string()),
  steps: z.array(StepSchema),
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
  },
): Promise<SideRun> {
  const { strategy } = await ensureDeps(sourceAppDir, worktreePath, baseHash, headHash);
  const { port, conflict } = await resolvePort(opts.port);
  const groups = [...new Set(scenarios.map((s) => s.group))].sort();
  const steps: StepObservation[] = [];
  const dbHash: Record<string, Record<string, string>> = {};
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
        PATH: process.env.PATH as string,
        NODE_ENV: "test",
        PORT: String(port),
        FROZEN_TIME: "2026-01-01T00:00:00Z",
        SEED: "42",
        DB_PATH: dbPath,
        EXTERNAL_MODE: "mock",
        OUTBOUND_LOG: outboundLog,
        ...(opts.env ?? {}),
      });
      try {
        await waitHealth(port, opts.healthTimeoutMs, () => child.exitCode !== null);
        for (const s of scenarios.filter((x) => x.group === group)) {
          let vars: Record<string, unknown> = {};
          for (let i = 0; i < s.steps.length; i++) {
            const step = s.steps[i] as z.infer<typeof StepSchema>;
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
  return { result: { steps, dbHash, outbound }, depsStrategy: strategy, port, portConflict: conflict };
}

/** Full differential replay: base vs head. Never throws across the boundary — returns typed results. */
export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const started = Date.now();
  const workRoot = opts.workRoot ?? join(process.cwd(), ".ripplewitness", "runs", `run-${started}`);
  mkdirSync(workRoot, { recursive: true });
  const appDir = opts.appDir ?? ".";
  const appStart = opts.appStart ?? ["corepack", "pnpm", "start"];
  const stepTimeoutMs = opts.stepTimeoutMs ?? 15000;
  const healthTimeoutMs = opts.healthTimeoutMs ?? 15000;
  let scenarios: Scenario[];
  try {
    scenarios = loadScenarios(opts.scenariosDir);
  } catch (err) {
    return { ok: false, error: { stage: "scenarios", message: String(err) } };
  }
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
    if (!existsSync(seedBase) || !existsSync(seedHead)) {
      return { ok: false, error: { stage: "seed", message: `seed DB missing: ${opts.seedDbRel}` } };
    }
    const common = {
      workRoot,
      stepTimeoutMs,
      healthTimeoutMs,
      ...(opts.env ? { env: opts.env } : {}),
    };
    let base: SideRun;
    let head: SideRun;
    try {
      base = await runSide(baseAppDir, sourceAppDir, baseHash, headHash, scenarios, {
        ...common,
        seedDb: seedBase,
        appStart,
        port: opts.ports?.base ?? 8101,
        side: "base",
      });
      head = await runSide(headAppDir, sourceAppDir, baseHash, headHash, scenarios, {
        ...common,
        seedDb: seedHead,
        appStart,
        port: opts.ports?.head ?? 8102,
        side: "head",
      });
    } catch (err) {
      return { ok: false, error: { stage: "replay", message: String(err) } };
    }
    // Post-condition: ports released (IT-REP-06/09).
    for (const p of [base.port, head.port]) {
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
