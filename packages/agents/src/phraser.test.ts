import { describe, expect, it } from "vitest";
import { MetaClient } from "./meta.js";
import { phraseQuestion } from "./phraser.js";

process.env.RIPPLEWITNESS_NO_CACHE = "1";

function mockFetch(contents: string[]): typeof fetch {
  let i = 0;
  return (async () => {
    const content = contents[Math.min(i, contents.length - 1)] as string;
    i += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;
}

describe("question phraser B2 (CT-PHR-01)", () => {
  const raw = "[[route:GET /a]] changed at runtime but no static path links it to this diff. What coupling explains it?";

  it("uses the LLM text when protected tokens survive", async () => {
    const c = new MetaClient({ apiKey: "t", fetchImpl: mockFetch(['{"text":"Why did route:GET /a change with no static path to the diff?"}']) });
    const r = await phraseQuestion(c, raw, { tone: "socratic" });
    expect(r).toEqual({ text: "Why did route:GET /a change with no static path to the diff?", usedLlm: true });
  });

  it("falls back to the raw template when a token is dropped", async () => {
    const c = new MetaClient({ apiKey: "t", fetchImpl: mockFetch(['{"text":"Why did something change?"}', '{"text":"Why did it change?"}']) });
    const r = await phraseQuestion(c, raw);
    expect(r.usedLlm).toBe(false);
    expect(r.text).toBe("route:GET /a changed at runtime but no static path links it to this diff. What coupling explains it?");
    expect(r.text).not.toContain("[[");
  });

  it("falls back on transport and schema failures, never throws", async () => {
    const down = new MetaClient({
      apiKey: "t",
      fetchImpl: (() => Promise.reject(new Error("down"))) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });
    await expect(phraseQuestion(down, raw)).resolves.toMatchObject({ usedLlm: false });
    const bad = new MetaClient({ apiKey: "t", fetchImpl: mockFetch(["junk", "junk"]) });
    await expect(phraseQuestion(bad, raw)).resolves.toMatchObject({ usedLlm: false });
  });

  it("skips the call when there is nothing to protect", async () => {
    let n = 0;
    const c = new MetaClient({
      apiKey: "t",
      fetchImpl: ((async () => {
        n += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown) as typeof fetch,
    });
    await expect(phraseQuestion(c, "plain text")).resolves.toEqual({ text: "plain text", usedLlm: false });
    expect(n).toBe(0);
    expect(c.calls).toBe(0);
  });
});
