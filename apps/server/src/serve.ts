import { join } from "node:path";
import { ExecSession, MockSession } from "@ripplewitness/agents";
import type { ExplainerInput, SummaryInput } from "@ripplewitness/agents";
import { createServer } from "./app.js";
import type { ServerOptions } from "./app.js";
import { loadConfig } from "./config.js";
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

export function start(port = Number(process.env.RIPPLEWITNESS_PORT ?? 4400)): void {
  const home = process.env.RIPPLEWITNESS_HOME ?? join(process.cwd(), ".ripplewitness");
  const loaded = loadConfig(home);
  if (!loaded.ok) {
    log.error("config_invalid", { error: loaded.error });
    process.exit(2);
  }
  const cfg = loaded.config;
  if (loaded.path) log.info("config_loaded", { path: loaded.path });
  const db = openStore(join(home, "runs.db"));
  const key = process.env.META_API_KEY;
  if (!key) {
    log.info("startup_no_llm", { detail: "META_API_KEY unset: deterministic core only" });
  }
  const app = createServer(db, {
    workRoot: join(home, "wt"),
    home,
    // Cross-examination talks to the real agent CLI; a missing/failing
    // `muse` binary surfaces as 503 agent_unavailable, never a fake answer.
    // RIPPLEWITNESS_AGENT_SESSION=stub swaps in the scripted session for
    // tests/offline demos (answers label themselves reinstantiated).
    session: process.env.RIPPLEWITNESS_AGENT_SESSION === "stub" ? new MockSession() : new ExecSession(),
    gate: cfg.gate,
    agentDefaults: { explainerMaxSentences: cfg.explainerMaxSentences, summaryStyle: cfg.summaryStyle },
    ...buildLlmOptions(key, { tone: cfg.tone }),
  });
  app.listen(port, "127.0.0.1", () => log.info("listening", { port }));
}
