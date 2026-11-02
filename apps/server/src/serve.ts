import { join } from "node:path";
import type { ExplainerInput, SummaryInput } from "@ripplewitness/agents";
import { createServer } from "./app.js";
import { openStore } from "./store.js";

export function start(port = Number(process.env.RIPPLEWITNESS_PORT ?? 4400)): void {
  const home = process.env.RIPPLEWITNESS_HOME ?? join(process.cwd(), ".ripplewitness");
  const db = openStore(join(home, "runs.db"));
  const key = process.env.META_API_KEY;
  if (!key) {
    console.log("META_API_KEY unset: LLM assistants degrade to NO-LLM mode (deterministic core still works).");
  }
  const app = createServer(db, {
    workRoot: join(home, "wt"),
    home,
    ...(key
      ? {
          reviewer: async (diff: string) => {
            const { MetaClient, runReviewer } = await import("@ripplewitness/agents");
            return { findings: await runReviewer(new MetaClient({ apiKey: key }), diff) };
          },
          explainer: async (input: ExplainerInput) => {
            const { MetaClient, runExplainer } = await import("@ripplewitness/agents");
            return runExplainer(new MetaClient({ apiKey: key }), input);
          },
          summarizer: async (input: SummaryInput) => {
            const { MetaClient, runSummary } = await import("@ripplewitness/agents");
            return runSummary(new MetaClient({ apiKey: key }), input);
          },
        }
      : {}),
  });
  app.listen(port, "127.0.0.1", () => console.log(`ripplewitness listening:${port}`));
}
