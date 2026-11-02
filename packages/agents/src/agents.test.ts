import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractClaims } from "./claims.js";
import { MetaClient, MetaDegraded, USER_CONTENT_CHAR_LIMIT } from "./meta.js";
import { redactSecrets } from "./redactor.js";
import { ExecSession, MockSession, parseExecJsonl } from "./session.js";

const execFileP = promisify(execFile);

function mockFetch(responses: { ok: boolean; status?: number; content?: string }[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)] as { ok: boolean; status?: number; content?: string };
    i += 1;
    return {
      ok: r.ok,
      status: r.status ?? 200,
      json: async () => ({ choices: [{ message: { content: r.content ?? "" } }] }),
    };
  }) as unknown as typeof fetch;
}

describe("redactor (CT-AGE-02)", () => {
  it("redacts bearer tokens, keys, and private keys without touching code", () => {
    const bearer = ["Bearer", "abc123"].join(" ");
    const out = redactSecrets(`function checkout(){} auth ${bearer} and sk-live-secret-value here`);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("sk-live-secret-value");
    expect(out).toContain("function checkout");
    expect(redactSecrets('const x = "api_key=supersecret"')).toContain("[REDACTED]");
    expect(redactSecrets("plain text")).toBe("plain text");
  });
  it("redacts github tokens", () => {
    expect(redactSecrets("token ghp_abcdefghijklmnopqrstuv")).toContain("[REDACTED]");
  });
});

describe("meta client (D-02)", () => {
  const schema = z.object({ answer: z.string() });
  it("parses valid JSON on first try", async () => {
    const c = new MetaClient({ apiKey: "test", fetchImpl: mockFetch([{ ok: true, content: '{"answer":"yes"}' }]) });
    await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "yes" });
    expect(c.calls).toBe(1);
  });
  it("one repair retry then success", async () => {
    const c = new MetaClient({
      apiKey: "test",
      fetchImpl: mockFetch([{ ok: true, content: "not json" }, { ok: true, content: '{"answer":"fixed"}' }]),
    });
    await expect(c.completeJson("s", "u", schema)).resolves.toEqual({ answer: "fixed" });
    expect(c.calls).toBe(2);
  });
  it("degrades after two failures", async () => {
    const c = new MetaClient({
      apiKey: "test",
      fetchImpl: mockFetch([{ ok: true, content: "junk" }, { ok: true, content: "junk" }]),
    });
    await expect(c.completeJson("s", "u", schema)).rejects.toBeInstanceOf(MetaDegraded);
  });
  it("missing key degrades without network", () => {
    expect(() => new MetaClient({ apiKey: "" })).toThrow(MetaDegraded);
  });
  it("model/baseUrl precedence: explicit opts > env > defaults", async () => {
    const seen: { url: string; model: string }[] = [];
    const cap = (): typeof fetch =>
      (async (url: unknown, init: unknown) => {
        const body = JSON.parse((init as { body: string }).body) as { model: string };
        seen.push({ url: String(url), model: body.model });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"yes"}' } }] }) };
      }) as unknown as typeof fetch;
    const oldModel = process.env.META_MODEL;
    const oldBase = process.env.META_BASE_URL;
    delete process.env.META_MODEL;
    delete process.env.META_BASE_URL;
    try {
      await new MetaClient({ apiKey: "test", fetchImpl: cap() }).completeJson("s", "u", schema);
      expect(seen[0]).toEqual({ url: "https://api.meta.ai/v1/chat/completions", model: "muse-spark-1.3" });
      process.env.META_MODEL = "env-model";
      process.env.META_BASE_URL = "https://env.example/v9";
      await new MetaClient({ apiKey: "test", fetchImpl: cap() }).completeJson("s", "u", schema);
      expect(seen[1]).toEqual({ url: "https://env.example/v9/chat/completions", model: "env-model" });
      await new MetaClient({ apiKey: "test", model: "opt-model", baseUrl: "https://opt.example", fetchImpl: cap() }).completeJson(
        "s",
        "u",
        schema,
      );
      expect(seen[2]).toEqual({ url: "https://opt.example/chat/completions", model: "opt-model" });
    } finally {
      if (oldModel === undefined) delete process.env.META_MODEL;
      else process.env.META_MODEL = oldModel;
      if (oldBase === undefined) delete process.env.META_BASE_URL;
      else process.env.META_BASE_URL = oldBase;
    }
  });
  it("user content is truncated to the prompt-fit budget", async () => {
    let content = "";
    const cap = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { messages: { content: string }[] };
      content = body.messages[1]?.content ?? "";
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"answer":"yes"}' } }] }) };
    }) as unknown as typeof fetch;
    await new MetaClient({ apiKey: "test", fetchImpl: cap }).completeJson("s", "x".repeat(20000), schema);
    expect(content.length).toBe(USER_CONTENT_CHAR_LIMIT);
  });
});

describe("claim extractor (CT-CLM-01 fixtures)", () => {
  const good = JSON.stringify({
    claims: [
      {
        type: "SCOPE",
        text: "Only touches checkout.",
        sourceSpan: [0, 22],
        params: { routes: ["route:POST /checkout", "route:FAKE /x"] },
      },
      { type: "TESTS", text: "Added 3 tests.", sourceSpan: [23, 37], params: { added: true } },
    ],
  });
  it("extracts typed claims and drops unknown routes", async () => {
    const c = new MetaClient({ apiKey: "t", fetchImpl: mockFetch([{ ok: true, content: good }]) });
    const claims = await extractClaims(c, "Only touches checkout. Added 3 tests.", ["route:POST /checkout"], ["src/app.ts"]);
    expect(claims).toHaveLength(2);
    expect(claims[0]?.params.routes).toEqual(["route:POST /checkout"]);
    expect(claims[1]?.type).toBe("TESTS");
  });
  it("empty message yields empty claims", async () => {
    const c = new MetaClient({ apiKey: "t", fetchImpl: mockFetch([{ ok: true, content: '{"claims":[]}' }]) });
    await expect(extractClaims(c, "thanks!", [], [])).resolves.toEqual([]);
  });
});

describe("session port (D-01)", () => {
  it("mock session replays scripted answers read-only", async () => {
    const m = new MockSession(["first", "not verified"]);
    await expect(m.ask("q1")).resolves.toMatchObject({ text: "first" });
    await expect(m.ask("q2")).resolves.toMatchObject({ text: "not verified", mode: "reinstantiated_from_transcript" });
    expect(m.asked).toHaveLength(2);
  });
  it("parses recorded exec JSONL (echo transcript fixture)", () => {
    const ndjson = [
      '{"schema_version":1,"payload_type":"runtime.command.accepted"}',
      '{"schema_version":1,"payload_type":"run.output.delta","text":"echo: hello"}',
      '{"schema_version":1,"payload_type":"run.terminal.completed","text":"echo: hello"}',
      "not json",
    ].join("\n");
    expect(parseExecJsonl(ndjson)).toBe("echo: hello");
    expect(parseExecJsonl("")).toBe("");
  });
  it("live echo provider round-trips read-only flags (skips without binary)", async () => {
    const home = mkdtempSync(join(tmpdir(), "rw-ses-"));
    const s = new ExecSession({ provider: "echo", home, timeoutMs: 30000 });
    let text: string;
    try {
      const ans = await s.ask("Reply with exactly: hello-ripple", { workdir: home });
      text = ans.text;
    } catch (err) {
      if (String(err).includes("ENOENT")) return; // no muse binary here
      throw err;
    }
    expect(text).toContain("hello-ripple");
  });
  it("muse binary supports read-only flags (skips without binary)", async () => {
    try {
      const { stdout } = await execFileP("muse", ["exec", "--help"]);
      expect(stdout).toContain("--disable-write");
      expect(stdout).toContain("--disable-shell");
    } catch (err) {
      if (String(err).includes("ENOENT")) return;
      throw err;
    }
  });
});
