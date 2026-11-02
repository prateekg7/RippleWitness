import { execa } from "execa";

export interface Worktree {
  path: string;
  ref: string;
}

/**
 * Create an isolated worktree. Uses --detach so a branch that is already
 * checked out elsewhere (e.g. main in the primary checkout) still works (S-03).
 */
export async function createWorktree(repoPath: string, ref: string, targetPath: string): Promise<Worktree> {
  await execa("git", ["worktree", "add", "--detach", targetPath, ref], { cwd: repoPath });
  return { path: targetPath, ref };
}

export async function removeWorktree(repoPath: string, targetPath: string): Promise<void> {
  await execa("git", ["worktree", "remove", "--force", targetPath], { cwd: repoPath });
  await execa("git", ["worktree", "prune"], { cwd: repoPath });
}

export async function revParse(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", ref], { cwd: repoPath });
  return stdout.trim();
}
