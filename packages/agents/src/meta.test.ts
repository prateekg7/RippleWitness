import { describe, expect, it } from "vitest";

// Unit tests must never touch a real response cache.
process.env.RIPPLEWITNESS_NO_CACHE = "1";
import { z } from "zod";
import { MetaClient, MetaDegraded, clearRunClients, metaClientForRun, parseFallbackEnv } from "./meta.js";
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

  it("uses a configured open-weight fallback after primary transport exhaustion", async () => {
    const seen: { url: string; model: string }[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      seen.push({ url: String(url), model });
      if (model === "muse-spark-1.3") return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"fallback"}' } }] }) };
    }) as unknown as typeof fetch;
    const c = new MetaClient({
      apiKey: "t",
      maxRetries: 0,
      sleepImpl: async () => {},
      fetchImpl,
      fallback: { model: "open-model", baseUrl: "http://127.0.0.1:8000/v1" },
    });
    await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "fallback" });
    expect(seen).toEqual([
      { url: "https://api.meta.ai/v1/chat/completions", model: "muse-spark-1.3" },
      { url: "http://127.0.0.1:8000/v1/chat/completions", model: "open-model" },
    ]);
    expect(c.getModelChain()).toEqual(["muse-spark-1.3", "open-model"]);
    expect(c.getMetrics().models).toEqual({ "open-model": 1 });
    expect(c.getMetrics().fallbackCalls).toBe(1);
  });

  it("uses fallback for an unreachable primary model 404", async () => {
    const models: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      models.push(model);
      if (model === "muse-spark-1.3") return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"fallback"}' } }] }) };
    }) as unknown as typeof fetch;
    const c = new MetaClient({
      apiKey: "t",
      maxRetries: 0,
      sleepImpl: async () => {},
      fetchImpl,
      fallback: { model: "open-model", baseUrl: "http://127.0.0.1:8000/v1" },
    });
    await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "fallback" });
    expect(models).toEqual(["muse-spark-1.3", "open-model"]);
  });

  it("does not use fallback for primary schema failures; it repairs on the primary", async () => {
    const models: string[] = [];
    const contents = ["not json", '{"answer":"repaired"}'];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      models.push(model);
      const content = contents[Math.min(models.length - 1, contents.length - 1)] as string;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    }) as unknown as typeof fetch;
    const c = new MetaClient({
      apiKey: "t",
      maxRetries: 0,
      sleepImpl: async () => {},
      fetchImpl,
      fallback: { model: "open-model", baseUrl: "http://127.0.0.1:8000/v1" },
    });
    await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "repaired" });
    expect(models).toEqual(["muse-spark-1.3", "muse-spark-1.3"]);
    expect(c.getMetrics().fallbackCalls).toBe(0);
  });

  it("does not use fallback for a non-retryable primary 400", async () => {
    const models: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      models.push((JSON.parse(init.body) as { model: string }).model);
      return { ok: false, status: 400, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const c = new MetaClient({
      apiKey: "t",
      maxRetries: 0,
      sleepImpl: async () => {},
      fetchImpl,
      fallback: { model: "open-model", baseUrl: "http://127.0.0.1:8000/v1" },
    });
    await expect(c.completeJson("s", "u", schema)).rejects.toThrow(/HTTP 400/);
    expect(models).toEqual(["muse-spark-1.3", "muse-spark-1.3"]);
  });

  it("validates fallback configuration and preserves the local-first network boundary", () => {
    expect(() => new MetaClient({ apiKey: "t", fallback: { model: "open-model" } })).toThrow(/fallback\[1\] base URL/i);
    expect(() => new MetaClient({ apiKey: "t", fallback: { baseUrl: "http://127.0.0.1:8000/v1" } })).toThrow(/fallback\[1\] model/i);
    expect(
      () =>
        new MetaClient({
          apiKey: "t",
          fallback: { model: "open-model", baseUrl: "https://models.example.com/v1" },
        }),
    ).toThrow(/loopback|same origin/i);
    expect(
      () =>
        new MetaClient({
          apiKey: "t",
          fallback: { model: "muse-spark-1.3", baseUrl: "https://api.meta.ai/v1" },
        }),
    ).toThrow(/duplicates the primary/i);
    let credentialError = "";
    try {
      new MetaClient({
        apiKey: "t",
        fallback: { model: "open-model", baseUrl: "http://user:fallback-password@127.0.0.1:8000/v1" },
      });
    } catch (e) {
      credentialError = e instanceof Error ? e.message : String(e);
    }
    expect(credentialError).toMatch(/must not embed credentials/i);
    expect(credentialError).not.toContain("fallback-password");
    expect(() =>
      parseFallbackEnv({
        META_FALLBACK_MODELS: "open-one,open-two",
        META_FALLBACK_BASE_URLS: "http://127.0.0.1:8000/v1",
      }),
    ).toThrow(/same length/i);
  });

  it("treats blank META_MODEL/META_BASE_URL placeholders as unset", () => {
    const oldModel = process.env.META_MODEL;
    const oldBaseUrl = process.env.META_BASE_URL;
    process.env.META_MODEL = "";
    process.env.META_BASE_URL = "   ";
    try {
      const c = new MetaClient({ apiKey: "t" });
      expect(c.getModelChain()).toEqual(["muse-spark-1.3"]);
    } finally {
      if (oldModel === undefined) delete process.env.META_MODEL;
      else process.env.META_MODEL = oldModel;
      if (oldBaseUrl === undefined) delete process.env.META_BASE_URL;
      else process.env.META_BASE_URL = oldBaseUrl;
    }
  });

  it("reads an ordered fallback chain from the environment", () => {
    const oldModels = process.env.META_FALLBACK_MODELS;
    const oldBaseUrls = process.env.META_FALLBACK_BASE_URLS;
    process.env.META_FALLBACK_MODELS = "env-open-one,env-open-two";
    process.env.META_FALLBACK_BASE_URLS = "http://127.0.0.1:8000/v1,http://127.0.0.1:8001/v1";
    try {
      const c = new MetaClient({ apiKey: "t" });
      expect(c.getModelChain()).toEqual(["muse-spark-1.3", "env-open-one", "env-open-two"]);
    } finally {
      if (oldModels === undefined) delete process.env.META_FALLBACK_MODELS;
      else process.env.META_FALLBACK_MODELS = oldModels;
      if (oldBaseUrls === undefined) delete process.env.META_FALLBACK_BASE_URLS;
      else process.env.META_FALLBACK_BASE_URLS = oldBaseUrls;
    }
  });

  it("tries fallback targets in order and never sends the primary key to a separate endpoint", async () => {
    const seen: { url: string; model: string; authorization: string | undefined }[] = [];
    const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      seen.push({ url: String(url), model, authorization: init.headers.authorization });
      if (model !== "open-two") return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"fallback"}' } }] }) };
    }) as unknown as typeof fetch;
    const c = new MetaClient({
      apiKey: "primary-secret",
      maxRetries: 0,
      sleepImpl: async () => {},
      fetchImpl,
      fallback: [
        { model: "open-one", baseUrl: "http://127.0.0.1:8000/v1" },
        { model: "open-two", baseUrl: "http://127.0.0.1:8001/v1" },
      ],
    });
    await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "fallback" });
    expect(seen.map((call) => call.model)).toEqual(["muse-spark-1.3", "open-one", "open-two"]);
    expect(seen.map((call) => call.authorization)).toEqual(["Bearer primary-secret", undefined, undefined]);
    expect(c.getModelChain()).toEqual(["muse-spark-1.3", "open-one", "open-two"]);
    expect(c.getMetrics().models).toEqual({ "open-two": 1 });
    expect(c.getMetrics().fallbackCalls).toBe(1);
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
