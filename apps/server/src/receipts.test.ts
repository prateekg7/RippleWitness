import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hashArtifactFiles, issueReceipt, tierForReviewMode } from "./receipts.js";
import { openStore, putArtifact } from "./store.js";

const exec = promisify(execFile);

describe("receipt provenance (F-25)", () => {
  it("hashes declared files, records missing/escaping entries with reasons", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-art-"));
    writeFileSync(join(dir, "model.json"), '{"v":1}');
    const out = hashArtifactFiles(dir, ["model.json", "nope.bin", "../escape", "/abs"]);
    expect(out["model.json"]).toBe(`sha256:${createHash("sha256").update('{"v":1}').digest("hex")}`);
    expect(out["nope.bin"]).toMatch(/^missing:/);
    expect(out["../escape"]).toMatch(/^rejected:/);
    expect(out["/abs"]).toMatch(/^rejected:/);
  });
  it("maps review modes to tiers conservatively", () => {
    expect(tierForReviewMode("full")).toBe("L3");
    expect(tierForReviewMode("dynamic-only")).toBe("L2");
    expect(tierForReviewMode("static-only")).toBe("L0");
    expect(tierForReviewMode("anything-else")).toBe("L3");
  });
});

describe("receipt agentMode honesty", () => {
  async function scratch(asked: { mode?: string } | null, refStyle: "sha" | "rev" = "sha"): Promise<{ agentMode: string; payload: { baseRef: string; headRef: string } }> {
    const repo = mkdtempSync(join(tmpdir(), "rw-rcpt-"));
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
    await exec("git", ["config", "user.email", "t@l"], { cwd: repo });
    await exec("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "f.txt"), "a\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "base"], { cwd: repo });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    writeFileSync(join(repo, "f.txt"), "b\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "head"], { cwd: repo });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "rw-rcpt-db-"));
    const db = openStore(join(dir, "runs.db"));
    db.prepare(
      "INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, prediction, score, locked, overrideReason, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "r1",
      repo,
      refStyle === "rev" ? "HEAD~1" : base,
      refStyle === "rev" ? "HEAD" : head,
      "ready",
      "{}",
      JSON.stringify({ routeIds: [], nothingElse: true }),
      JSON.stringify({ recall: 1, precision: 1, passed: true, passReason: "nothing_else_correct" }),
      1,
      null,
      new Date().toISOString(),
    );
    const scen = mkdtempSync(join(tmpdir(), "rw-rcpt-scen-"));
    putArtifact(db, "r1", "inputs", { scenariosDir: scen });
    if (asked) {
      db.prepare("INSERT INTO questions (id, runId, template, routeId, claimId, status, askedCount, answer, need) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "q1",
        "r1",
        "SURPRISE_RIPPLE",
        null,
        null,
        "ASKED",
        1,
        JSON.stringify({ text: "ans", followup: null, ...(asked.mode ? { mode: asked.mode } : {}) }),
        0,
      );
    }
    const out = await issueReceipt(db, dir, "r1");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error);
    return { agentMode: out.receipt.payload.agentMode, payload: out.receipt.payload };
  }

  it("records not_asked, then the answer's real mode", async () => {
    await expect(scratch(null)).resolves.toMatchObject({ agentMode: "not_asked" });
    await expect(scratch({ mode: "live_session" })).resolves.toMatchObject({ agentMode: "live_session" });
    await expect(scratch({})).resolves.toMatchObject({ agentMode: "reinstantiated_from_transcript" });
  });

  it("binds resolved SHAs even when refs were given as revs", async () => {
    const { payload } = await scratch(null, "rev");
    expect(payload.baseRef).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.headRef).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.baseRef).not.toBe(payload.headRef);
  });
});
