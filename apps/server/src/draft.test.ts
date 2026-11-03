import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarios } from "@ripplewitness/replay";
import { draftScenarios, runDraft } from "./draft.js";

describe("scenario drafter B7 (CT-B7-01)", () => {
  it("drafts one skeleton per route with method-aware bodies", () => {
    const drafts = draftScenarios(["route:GET /a", "route:POST /b"]);
    expect(drafts.map((d) => d.file)).toEqual(["draft-01.json", "draft-02.json"]);
    expect(drafts[0]?.body).toMatchObject({ id: "draft-1", routeIds: ["route:GET /a"] });
    expect(drafts[1]?.body).toMatchObject({ steps: [{ method: "POST", path: "/b", body: {} }] });
  });

  it("writes loadable scenario files", () => {
    const out = mkdtempSync(join(tmpdir(), "rw-draft-"));
    const r = runDraft(["route:GET /a"], out);
    expect(r.ok).toBe(true);
    expect(readdirSync(out)).toEqual(["draft-01.json"]);
    const loaded = loadScenarios(out);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.routeIds).toEqual(["route:GET /a"]);
    expect(readFileSync(join(out, "draft-01.json"), "utf8")).toContain("_todo");
  });

  it("refuses empty input", () => {
    expect(runDraft([], mkdtempSync(join(tmpdir(), "rw-draft-")))).toEqual({ ok: false, error: "no routes given" });
  });
});
