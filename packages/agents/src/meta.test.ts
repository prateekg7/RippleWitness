import { describe, expect, it } from "vitest";

// Unit tests must never touch a real response cache.
process.env.RIPPLEWITNESS_NO_CACHE = "1";
import { z } from "zod";
import { MetaClient, MetaDegraded, clearRunClients, metaClientForRun } from "./meta.js";
import { runReviewer } from "./reviewer.js";

const schema = z.object({ answer: z.string() });

type Resp = { ok: boolean; status?: number; content?: string; usage?: { prompt_tokens: number; completion_tokens: number } };

function seq(responses: Resp[]): { fetchImpl: typeof fetch } {
  let i = 0;
  const fetchImpl = (async () => {
    const r = responses[Math.min(i, responses.length - 1)] as Resp;
    i += 1;
    return {
      ok: r.ok,
      status: r.status ?? 200,
      json: async () => ({ choices: [{ message: { content: r.content ?? "" } }], usage: r.usage }),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

describe("meta transport hardening (CT-AGE-03)", () => {
  it("retries a 503 with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = seq([
      { ok: false, status: 503 },
      { ok: true, content: '{"answer":"yes"}' },
    ]);
    let n = 0;
    const counting = (async (...a: unknown[]) => {
      n += 1;
      return (fetchImpl as (...args: unknown[]) => Promise<Response>)(...a);
    }) as unknown as typeof fetch;
    const c = new MetaClient({
      apiKey: "t",
      fetchImpl: counting,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "yes" });
    expect(n).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(c.getMetrics().transportRetries).toBe(1);
  });

  it("gives up after maxRetries on persistent 429", async () => {
    let n = 0;
    const c = new MetaClient({
      apiKey: "t",
      maxRetries: 2,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        n += 1;
        return { ok: false, status: 429, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    await expect(c.completeJson("s", "u", schema)).rejects.toBeInstanceOf(MetaDegraded);
    // 2 schema attempts x (1 + 2 transport retries)
    expect(n).toBe(6);
    expect(c.getMetrics().transportRetries).toBe(4);
  });

  it("does not retry a non-retryable 400", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const c = new MetaClient({
      apiKey: "t",
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: (async () => {
        n += 1;
        return { ok: false, status: 400, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    await expect(c.completeJson("s", "u", schema)).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(2); // one per schema attempt, no transport retry
    expect(sleeps).toEqual([]);
  });

  it("times out a hanging call and counts timeouts", async () => {
    const c = new MetaClient({
      apiKey: "t",
      timeoutMs: 10,
      maxRetries: 1,
      sleepImpl: async () => {},
      fetchImpl: ((url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })) as unknown as typeof fetch,
    });
    await expect(c.completeJson("s", "u", schema)).rejects.toThrow(/timeout/);
    expect(c.getMetrics().timeouts).toBeGreaterThan(0);
  });

  it("enforces the per-run call cap", async () => {
    const c = new MetaClient({
      apiKey: "t",
      maxCallsPerRun: 2,
      fetchImpl: seq([{ ok: true, content: '{"answer":"y"}' }]).fetchImpl,
    });
    await c.completeJson("s", "u", schema, 1000, { runId: "r1" });
    await c.completeJson("s", "u", schema, 1000, { runId: "r1" });
    await expect(c.completeJson("s", "u", schema, 1000, { runId: "r1" })).rejects.toThrow(/call cap/);
    await expect(c.completeJson("s", "u", schema, 1000, { runId: "r2" })).resolves.toEqual({ answer: "y" });
  });

  it("accumulates token usage and per-agent buckets", async () => {
    const c = new MetaClient({
      apiKey: "t",
      fetchImpl: seq([{ ok: true, content: '{"findings":[]}', usage: { prompt_tokens: 10, completion_tokens: 3 } }]).fetchImpl,
    });
    await runReviewer(c, "diff", { runId: "r1" });
    const m = c.getMetrics();
    expect(m.tokensIn).toBe(10);
    expect(m.tokensOut).toBe(3);
    expect(m.perAgent.aiReviewer?.calls).toBe(1);
    expect(m.perAgent.aiReviewer?.schemaValid).toBe(1);
    expect(m.perRun.r1).toBe(1);
  });

  it("caches validated responses by content hash (CT-AGE-05)", async () => {
    const prev = process.env.RIPPLEWITNESS_NO_CACHE;
    delete process.env.RIPPLEWITNESS_NO_CACHE;
    try {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "rw-cache-"));
      let n = 0;
      const counting = (async () => {
        n += 1;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"y"}' } }] }) };
      }) as unknown as typeof fetch;
      const c = new MetaClient({ apiKey: "t", fetchImpl: counting, cacheDir: dir });
      await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "y" });
      await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "y" });
      expect(n).toBe(1);
      expect(c.getMetrics().cacheHits).toBe(1);
      await expect(c.completeJson("s", "different", schema)).resolves.toEqual({ answer: "y" });
      expect(n).toBe(2);
      // Poisoned entries fail validation and fall through to a live call.
      const { writeFileSync, readdirSync } = await import("node:fs");
      const { cacheKey } = await import("./cache.js");
      const { INJECTION_GUARD } = await import("./meta.js");
      const badKey = cacheKey("muse-spark-1.3", `${INJECTION_GUARD}\ns`, "poison", "v1");
      writeFileSync(join(dir, `${badKey}.json`), "not json{{{");
      expect(readdirSync(dir)).toContain(`${badKey}.json`);
      await expect(c.completeJson("s", "poison", schema)).resolves.toEqual({ answer: "y" });
      expect(n).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.RIPPLEWITNESS_NO_CACHE;
      else process.env.RIPPLEWITNESS_NO_CACHE = prev;
    }
  });

  it("RIPPLEWITNESS_NO_CACHE=1 disables the cache", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "rw-cache-"));
    let n = 0;
    const counting = (async () => {
      n += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"y"}' } }] }) };
    }) as unknown as typeof fetch;
    const c = new MetaClient({ apiKey: "t", fetchImpl: counting, cacheDir: dir });
    await c.completeJson("s", "u", schema);
    await c.completeJson("s", "u", schema);
    expect(n).toBe(2);
    expect(c.getMetrics().cacheHits).toBe(0);
  });

  it("metaClientForRun shares one client per run", () => {
    clearRunClients();
    const a = metaClientForRun("r1", { apiKey: "t" });
    const b = metaClientForRun("r1", { apiKey: "t" });
    const c = metaClientForRun("r2", { apiKey: "t" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    clearRunClients();
    expect(metaClientForRun("r1", { apiKey: "t" })).not.toBe(a);
  });
});
