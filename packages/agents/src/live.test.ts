import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MetaClient } from "./meta.js";

const LIVE = process.env.RIPPLEWITNESS_LIVE === "1";

// Live smoke (AGENTS.md B8, TRD §12.2): one tiny real call against the Meta
// Model API. Skipped by default so `pnpm test` stays offline; enable with
// RIPPLEWITNESS_LIVE=1 plus META_API_KEY. Fails fast without a key.
describe.runIf(LIVE)("meta client live smoke (RIPPLEWITNESS_LIVE=1)", () => {
  it(
    "round-trips a tiny JSON completion",
    async () => {
      const client = new MetaClient();
      const out = await client.completeJson(
        "Reply with exactly the requested JSON and nothing else.",
        'Reply with exactly: {"pong":true}',
        z.object({ pong: z.boolean() }).passthrough(),
        50,
      );
      expect(out.pong).toBe(true);
    },
    60000,
  );
});
