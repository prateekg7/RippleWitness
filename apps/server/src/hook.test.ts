import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadOrCreateKey, signReceipt, writeNote } from "@ripplewitness/receipt";
import { checkHead, installHook } from "./hook.js";

const execFileP = promisify(execFile);

async function scratchRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rw-hook-"));
  await execFileP("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
  await execFileP("git", ["config", "user.email", "t@l"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "t"], { cwd: dir });
  await execFileP("git", ["commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
  return dir;
}

describe("strict mode hook (E-05)", () => {
  it("CT-SM-01: install writes an executable pre-push hook", async () => {
    const repo = await scratchRepo();
    const p = installHook(repo, "/tmp/rw-root");
    expect(p.endsWith("pre-push")).toBe(true);
    expect(statSync(p).mode & 0o111).not.toBe(0);
    expect(readFileSync(p, "utf8")).toContain("hook check");
  });
  it("CT-SM-02: no note blocks; valid note passes", async () => {
    const repo = await scratchRepo();
    const home = mkdtempSync(join(tmpdir(), "rw-home-"));
    expect(await checkHead(repo, home)).toMatchObject({ ok: false });
    const receipt = signReceipt(
      {
        runId: "r",
        baseRef: "b",
        headRef: "h",
        diffHash: "d",
        scenarioHash: "s",
        prediction: {},
        score: { recall: 1, precision: 1, passed: true, passReason: "t" },
        overrideReason: null,
        claims: [],
        questions: [],
        agentMode: "live_session",
        createdAt: "2026-01-01T00:00:00Z",
      },
      loadOrCreateKey(home),
    );
    await writeNote(repo, "HEAD", JSON.stringify(receipt));
    expect(await checkHead(repo, home)).toEqual({ ok: true });
  });
});
