import { join } from "node:path";
import { ExecSession, MockSession, envText } from "@ripplewitness/agents";
import { randomUUID } from "node:crypto";
import { runAnalysis } from "./pipeline.js";
import type { ExplainerInput, SummaryInput } from "@ripplewitness/agents";
import { createServer } from "./app.js";
import type { ServerOptions } from "./app.js";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./envfile.js";
import { log } from "./log.js";
import { openStore } from "./store.js";

/** LLM hooks for prod: all agents share per-run clients. Pure (BUG-002). */
export function buildLlmOptions(
  key: string | undefined,
  opts: { tone?: "direct" | "neutral" | "socratic" } = {},
): Pick<ServerOptions, "extractor" | "reviewer" | "explainer" | "summarizer" | "phraser" | "planner"> {
  if (!key) return {};
  return {
    phraser: async (raw: string, runId: string) => {
      const { metaClientForRun, phraseQuestion } = await import("@ripplewitness/agents");
      return (await phraseQuestion(metaClientForRun(runId, { apiKey: key }), raw, { tone: opts.tone ?? "neutral", ctx: { runId } })).text;
    },
    planner: async (hunks: { file: string; startLine: number; text: string }[], runId: string) => {
      const { metaClientForRun, planCanary } = await import("@ripplewitness/agents");
      return planCanary(metaClientForRun(runId, { apiKey: key }), hunks, { runId });
    },
    extractor: async (text: string, knownRoutes: string[], runId: string) => {
      const { extractClaims, metaClientForRun } = await import("@ripplewitness/agents");
      return extractClaims(metaClientForRun(runId, { apiKey: key }), text, knownRoutes, [], { runId });
    },
    reviewer: async (diff: string, runId: string) => {
      const { metaClientForRun, runReviewer } = await import("@ripplewitness/agents");
      return { findings: await runReviewer(metaClientForRun(runId, { apiKey: key }), diff, { runId }) };
    },
    explainer: async (input: ExplainerInput, runId: string) => {
      const { metaClientForRun, runExplainer } = await import("@ripplewitness/agents");
      return runExplainer(metaClientForRun(runId, { apiKey: key }), input, { runId });
    },
    summarizer: async (input: SummaryInput, runId: string) => {
      const { metaClientForRun, runSummary } = await import("@ripplewitness/agents");
      return runSummary(metaClientForRun(runId, { apiKey: key }), input, { runId });
    },
  };
}

/** Hosted-demo lock from RIPPLEWITNESS_LOCKED_RUN (JSON). Invalid JSON fails fast. */
export function lockedRunFromEnv(): import("./app.js").LockedRunConfig | undefined {
  const raw = envText(process.env.RIPPLEWITNESS_LOCKED_RUN);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RIPPLEWITNESS_LOCKED_RUN is not valid JSON");
  }
  const p = parsed as Partial<import("./app.js").LockedRunConfig>;
  if (!p.repoPath || !p.baseRef || !p.headRef || !p.scenariosDir) {
    throw new Error("RIPPLEWITNESS_LOCKED_RUN requires repoPath, baseRef, headRef, scenariosDir");
  }
  return p as import("./app.js").LockedRunConfig;
}

export function start(port = Number(envText(process.env.RIPPLEWITNESS_PORT) ?? 4400)): void {
  const envPath = loadDotEnv();
  if (envPath) log.info("env_loaded", { path: envPath });
  const home = envText(process.env.RIPPLEWITNESS_HOME) ?? join(process.cwd(), ".ripplewitness");
  const loaded = loadConfig(home);
  if (!loaded.ok) {
    log.error("config_invalid", { error: loaded.error });
    process.exit(2);
  }
  const cfg = loaded.config;
  if (loaded.path) log.info("config_loaded", { path: loaded.path });
  const db = openStore(join(home, "runs.db"));
  const key = envText(process.env.META_API_KEY);
  if (!key) {
    log.info("startup_no_llm", { detail: "META_API_KEY unset: deterministic core only" });
  }
  const lockedRun = lockedRunFromEnv();
  const app = createServer(db, {
    workRoot: join(home, "wt"),
    home,
    ...(lockedRun ? { lockedRun } : {}),
    // Cross-examination talks to the real agent CLI; a missing/failing
    // `muse` binary surfaces as 503 agent_unavailable, never a fake answer.
    // RIPPLEWITNESS_AGENT_SESSION=stub swaps in the scripted session for
    // tests/offline demos (answers label themselves reinstantiated).
    session:
      process.env.RIPPLEWITNESS_AGENT_SESSION === "stub"
        ? new MockSession(["not verified — hosted demo stub: no live agent session is attached, so this demonstrates the ask/re-verify loop only."])
        : new ExecSession(),
    gate: cfg.gate,
    agentDefaults: { explainerMaxSentences: cfg.explainerMaxSentences, summaryStyle: cfg.summaryStyle },
    ...buildLlmOptions(key, { tone: cfg.tone }),
  });
  app.listen(port, "127.0.0.1", () => {
    log.info("listening", { port });
    // Hosted demo: seed one completed run so a visitor lands on results,
    // not an empty form. Only when the store is empty and a run is locked.
    if (lockedRun) {
      const row = db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number };
      if (row.c === 0) {
        const runId = randomUUID();
        log.info("hosted_demo_seed_run", { runId });
        void runAnalysis(
          db,
          join(home, "wt"),
          {
            repoPath: lockedRun.repoPath,
            baseRef: lockedRun.baseRef,
            headRef: lockedRun.headRef,
            scenariosDir: lockedRun.scenariosDir,
            ...(lockedRun.appDir ? { appDir: lockedRun.appDir } : {}),
            ...(lockedRun.seedDbRel ? { seedDbRel: lockedRun.seedDbRel } : {}),
            ...(lockedRun.language ? { language: lockedRun.language } : {}),
            ...(lockedRun.appStart ? { appStart: lockedRun.appStart } : {}),
          },
          runId,
        );
      }
    }
  });
}
