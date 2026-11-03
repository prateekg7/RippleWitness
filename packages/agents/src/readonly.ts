import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Q&A read-only guard (SEC-07, AGENTS.md Part C). `muse exec` already runs
 * with --disable-write/--disable-shell, but flags are a request, not proof:
 * fingerprint the subject tree around every ask and refuse answers that
 * arrived with a modified tree.
 */

/** Porcelain status of the tree, or null when it cannot be read (guard skips). */
export async function treeFingerprint(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain"], { cwd: repoPath, timeout: 15000 });
    return stdout;
  } catch {
    return null;
  }
}

/** True when the ask left the tree untouched (or the tree is unreadable). Pure. */
export function treeUnchanged(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return true;
  return before === after;
}
