import { execa } from "execa";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureDeps } from "./deps.js";
import { scrubEnv, unsetProxies } from "./sandbox.js";

const TestRow = z.object({ kind: z.literal("test"), id: z.string(), outcome: z.string() });
const CallRow = z.object({
  kind: z.literal("call"),
  test: z.string(),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  body: z.unknown(),
  truncated: z.boolean(),
});
const HarvestLogRow = z.union([TestRow, CallRow, z.object({ kind: z.string() }).passthrough()]);

export interface HarvestedTest {
  id: string;
  outcome: "passed" | "failed" | "skipped" | "error";
}

export interface HarvestedCall {
  test: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  truncated: boolean;
}

export interface HarvestResult {
  tests: HarvestedTest[];
  calls: HarvestedCall[];
}

export type HarvestError = { stage: "pytest" | "parse" | "timeout"; message: string };

function shimDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "shim");
}

/**
 * Provision a worktree-local venv with the subject's requirements plus pytest
 * (F-24). Never touches the system interpreter. Returns the venv python path.
 */
export async function provisionHarvestEnv(
  worktreePath: string,
): Promise<{ ok: true; python: string } | { ok: false; error: HarvestError }> {
  try {
    await ensureDeps(worktreePath, worktreePath, "harvest", "harvest", { language: "python" });
    const venv = join(worktreePath, ".venv");
    if (!existsSync(join(venv, "bin", "python"))) {
      await execa("python3", ["-m", "venv", venv], { cwd: worktreePath, timeout: 120000 });
    }
    await execa(join(venv, "bin", "pip"), ["install", "--disable-pip-version-check", "pytest"], {
      cwd: worktreePath,
      timeout: 300000,
    });
    return { ok: true, python: join(venv, "bin", "python") };
  } catch (err) {
    return { ok: false, error: { stage: "pytest", message: `provision failed (network?): ${String(err).slice(0, 200)}` } };
  }
}

/**
 * Run a subject's pytest suite under the capture plugin (F-24). The plugin
 * loads via `-p` from our shim dir: nothing is written into the subject tree.
 * pytest exit codes 0/1/5 (pass/failures/no-tests) all yield parsed results;
 * anything else is a typed error. Never throws.
 */
export async function runHarvest(
  worktreePath: string,
  opts: { python?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ ok: true; result: HarvestResult } | { ok: false; error: HarvestError }> {
  const logFile = join(mkdtempSync(join(tmpdir(), "rw-harvest-")), "harvest.jsonl");
  const python = opts.python ?? "python3";
  const env = {
    PATH: process.env.PATH as string,
    PYTHONPATH: shimDir(),
    RW_HARVEST_LOG: logFile,
    ...scrubEnv(opts.env ?? {}),
    ...unsetProxies(),
  };
  let exitCode = 0;
  try {
    const r = await execa(python, ["-m", "pytest", "-p", "rw_pytest_capture", "-q", "--tb=no"], {
      cwd: worktreePath,
      env,
      // Strict env: the subject's tests are untrusted code and must not
      // inherit server secrets via execa's default env merge.
      extendEnv: false,
      timeout: opts.timeoutMs ?? 300000,
      reject: false,
    });
    exitCode = r.exitCode ?? -1;
  } catch (err) {
    if ((err as { timedOut?: boolean }).timedOut === true) {
      return { ok: false, error: { stage: "timeout", message: `pytest exceeded ${opts.timeoutMs ?? 300000}ms` } };
    }
    return { ok: false, error: { stage: "pytest", message: String(err).slice(0, 300) } };
  }
  if (![0, 1, 5].includes(exitCode)) {
    return { ok: false, error: { stage: "pytest", message: `pytest exited ${exitCode} (interrupted or unusable)` } };
  }
  let raw: string;
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    return { ok: false, error: { stage: "parse", message: "harvest log missing (plugin did not load?)" } };
  }
  const tests: HarvestedTest[] = [];
  const calls: HarvestedCall[] = [];
  for (const line of raw.split("\n").filter((l) => l.trim().length > 0)) {
    let row: z.infer<typeof HarvestLogRow>;
    try {
      row = HarvestLogRow.parse(JSON.parse(line));
    } catch {
      continue;
    }
    if (row.kind === "test") {
      const outcome = (row as z.infer<typeof TestRow>).outcome;
      tests.push({
        id: (row as z.infer<typeof TestRow>).id,
        outcome: outcome === "passed" || outcome === "failed" || outcome === "skipped" ? outcome : "error",
      });
    } else if (row.kind === "call") {
      const c = row as z.infer<typeof CallRow>;
      calls.push({ test: c.test, method: c.method.toUpperCase(), url: c.url, headers: c.headers, body: c.body, truncated: c.truncated });
    }
  }
  tests.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { ok: true, result: { tests, calls } };
}

export interface HarvestFlip {
  id: string;
  base: string;
  head: string;
}

/**
 * Diff two harvests (CT-HRV-01). Outcome flips are first-class observations;
 * added/removed tests are reported with "absent" on the missing side. Pure.
 */
export function diffHarvest(
  base: HarvestResult,
  head: HarvestResult,
): { flips: HarvestFlip[]; passingBoth: HarvestedCall[] } {
  const byId = (t: HarvestedTest[]): Map<string, string> => new Map(t.map((x) => [x.id, x.outcome]));
  const b = byId(base.tests);
  const h = byId(head.tests);
  const flips: HarvestFlip[] = [];
  for (const id of [...new Set([...b.keys(), ...h.keys()])].sort()) {
    const bo = b.get(id) ?? "absent";
    const ho = h.get(id) ?? "absent";
    if (bo !== ho) flips.push({ id, base: bo, head: ho });
  }
  const passing = new Set(head.tests.filter((t) => t.outcome === "passed" && b.get(t.id) === "passed").map((t) => t.id));
  const passingBoth = head.calls.filter((c) => passing.has(c.test) && !c.truncated);
  return { flips, passingBoth };
}

export interface CandidateScenario {
  /** Scenario-file-ready JSON (id/group/kind/steps/routeIds filled later by adoption). */
  id: string;
  group: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  sourceTest: string;
}

/**
 * Convert captured calls from passing-on-both tests into candidate HTTP
 * scenarios (CT-HRV-02 input). One step per call; absolute URLs reduce to
 * path+query. Pure — execution-keeping happens in adoption, not here.
 */
const HOP_HEADERS = new Set(["host", "connection", "content-length", "user-agent", "accept-encoding", "transfer-encoding"]);

export function harvestToScenarios(calls: HarvestedCall[]): CandidateScenario[] {
  return calls.map((c, i) => {
    let path = c.url;
    try {
      const u = new URL(c.url);
      path = `${u.pathname}${u.search}`;
    } catch {
      // Relative URL already.
    }
    // Drop hop-by-hop headers (stale Host ports, lengths); keep content-type etc.
    const headers = Object.fromEntries(Object.entries(c.headers).filter(([k]) => !HOP_HEADERS.has(k.toLowerCase())));
    return {
      id: `harvest-${i}`,
      group: "harvested",
      method: c.method,
      path,
      headers,
      body: c.body,
      sourceTest: c.test,
    };
  });
}
