import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { proposeWith } from "./operators.js";
import { validateCanary } from "./validate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("canary validation (E-04 live)", () => {
  it("CT-CN-04: flipped shipping comparison is accepted with real diffs", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "rw-can-"));
    cpSync(join(ROOT, "demo", "shop-api"), repoPath, {
      recursive: true,
      filter: (s) => !s.includes("node_modules") && !s.includes(".git"),
    });
    await execa("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
    await execa("git", ["config", "user.email", "t@l"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "t"], { cwd: repoPath });
    await execa("git", ["add", "-A"], { cwd: repoPath });
    await execa("git", ["commit", "-qm", "base"], { cwd: repoPath });
    const base = (await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    // Hosted subjects have no stored git identity; canary validation must
    // carry its own identity for the temp commit instead of failing.
    await execa("git", ["config", "--unset", "user.email"], { cwd: repoPath });
    await execa("git", ["config", "--unset", "user.name"], { cwd: repoPath });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(ROOT, "demo", "shop-api", "node_modules"), join(repoPath, "node_modules"), "dir");

    const scenariosDir = mkdtempSync(join(tmpdir(), "rw-can-scen-"));
    for (const f of readdirSync(join(ROOT, "demo", "scenarios"))) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      const s = JSON.parse(readFileSync(join(ROOT, "demo", "scenarios", f), "utf8")) as { group: string };
      if (["shipping", "checkout"].includes(s.group)) {
        writeFileSync(join(scenariosDir, f), readFileSync(join(ROOT, "demo", "scenarios", f)));
      }
    }
    const source = readFileSync(join(ROOT, "demo", "shop-api", "src", "app.ts"), "utf8");
    const candidate = proposeWith(source, "src/app.ts", "flip_cmp");
    expect(candidate).not.toBeNull();
    const verdict = await validateCanary({
      repoPath,
      baseRef: base,
      candidate: candidate as NonNullable<typeof candidate>,
      scenariosDir,
      seedDbRel: "seed/seed.db",
      workRoot: mkdtempSync(join(tmpdir(), "rw-can-wt-")),
    });
    expect(verdict.accepted).toBe(true);
    expect(verdict.changedRoutes).toContain("route:POST /checkout");
    // Temp branch cleaned up; repo untouched.
    const branches = (await execa("git", ["branch", "--list"], { cwd: repoPath })).stdout;
    expect(branches).not.toContain("rw-canary");
  });
});
