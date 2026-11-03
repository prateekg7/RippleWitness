import { describe, expect, it } from "vitest";
import { MetaClient } from "./meta.js";
import { planCanary } from "./canary-planner.js";

process.env.RIPPLEWITNESS_NO_CACHE = "1";

function mockFetch(contents: string[]): typeof fetch {
  let i = 0;
  return (async () => {
    const content = contents[Math.min(i, contents.length - 1)] as string;
    i += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;
}

const HUNKS = [{ file: "src/a.ts", startLine: 10, text: "+if (x > 1) return y;\n ctx" }];

describe("canary planner B6 (CT-PLN-01)", () => {
  it("returns a validated plan", async () => {
    const c = new MetaClient({
      apiKey: "t",
      fetchImpl: mockFetch(['{"file":"src/a.ts","line":10,"operator":"flip_cmp","rationale":"boundary"}']),
    });
    await expect(planCanary(c, HUNKS)).resolves.toEqual({ file: "src/a.ts", line: 10, operator: "flip_cmp", rationale: "boundary" });
  });

  it("returns null on unknown operator, traversal, empty hunks, or failure", async () => {
    const badOp = new MetaClient({
      apiKey: "t",
      fetchImpl: mockFetch(['{"file":"a","line":1,"operator":"nuke","rationale":"x"}', '{"file":"a","line":1,"operator":"nuke","rationale":"x"}']),
    });
    await expect(planCanary(badOp, HUNKS)).resolves.toBeNull();
    const trav = new MetaClient({
      apiKey: "t",
      fetchImpl: mockFetch(['{"file":"../a.ts","line":1,"operator":"flip_cmp","rationale":"x"}']),
    });
    await expect(planCanary(trav, HUNKS)).resolves.toBeNull();
    const ok = new MetaClient({ apiKey: "t", fetchImpl: mockFetch(['{"file":"a","line":1,"operator":"flip_cmp","rationale":"x"}']) });
    await expect(planCanary(ok, [])).resolves.toBeNull();
    expect(ok.calls).toBe(0);
    const down = new MetaClient({
      apiKey: "t",
      fetchImpl: (() => Promise.reject(new Error("down"))) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });
    await expect(planCanary(down, HUNKS)).resolves.toBeNull();
  });
});
