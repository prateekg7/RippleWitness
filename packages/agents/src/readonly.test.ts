import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { treeFingerprint, treeUnchanged } from "./readonly.js";

const exec = promisify(execFile);

describe("Q&A tree guard (SEC-07)", () => {
  it("detects tree modifications", () => {
    expect(treeUnchanged("a", "a")).toBe(true);
    expect(treeUnchanged("a", "b")).toBe(false);
    expect(treeUnchanged(null, "b")).toBe(true);
  });

  it("fingerprints a git tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-tree-"));
    expect(await treeFingerprint(dir)).toBeNull();
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    const before = await treeFingerprint(dir);
    expect(before).toBe("");
    writeFileSync(join(dir, "x.txt"), "x\n");
    expect(await treeFingerprint(dir)).not.toBe(before);
  });
});
