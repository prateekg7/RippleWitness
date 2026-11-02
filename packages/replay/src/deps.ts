import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

export type DepStrategy = "symlink" | "install";

function manifestHash(dir: string): string {
  const h = createHash("sha256");
  for (const f of ["package.json", "pnpm-lock.yaml", "package-lock.json"]) {
    const p = join(dir, f);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest("hex");
}

/**
 * Dependency strategy (TRD §7.2 step 2, S-03): when base and head manifests
 * are identical, symlink `node_modules` from the source checkout into both
 * worktrees; otherwise run a frozen install inside the worktree.
 * Returns the strategy used per worktree (for IT-REP-10 and run logs).
 */
export async function ensureDeps(
  sourceDir: string,
  worktreeDir: string,
  baseHash: string,
  headHash: string,
): Promise<{ strategy: DepStrategy; elapsedMs: number }> {
  const started = Date.now();
  const link = join(worktreeDir, "node_modules");
  if (existsSync(link)) unlinkSync(link);
  if (baseHash === headHash && existsSync(join(sourceDir, "node_modules"))) {
    symlinkSync(join(sourceDir, "node_modules"), link, "dir");
    return { strategy: "symlink", elapsedMs: Date.now() - started };
  }
  await execa("corepack", ["pnpm", "install", "--frozen-lockfile"], {
    cwd: worktreeDir,
    timeout: 120000,
  });
  return { strategy: "install", elapsedMs: Date.now() - started };
}

export function hashManifests(dir: string): string {
  return manifestHash(dir);
}
