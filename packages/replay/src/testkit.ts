import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/**
 * Test-only helper: builds scratch subject repos from demo fixtures.
 * Never imported by product code (only *.int.test.ts).
 */
export interface SubjectRepo {
  repoPath: string;
  base: string;
  heads: Record<string, string>;
}

export async function buildSubjectRepo(
  shopSrc: string,
  prsDir: string,
  patches: string[],
): Promise<SubjectRepo> {
  const repoPath = join(tmpdir(), `rw-subj-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(repoPath, { recursive: true });
  cpSync(shopSrc, repoPath, {
    recursive: true,
    filter: (s) => !s.includes("node_modules") && !s.includes(".git"),
  });
  const git = (args: string[]): Promise<unknown> =>
    execa("git", args, { cwd: repoPath }) as unknown as Promise<unknown>;
  await git(["init", "-q", "-b", "main", "."]);
  await git(["config", "user.email", "test@local"]);
  await git(["config", "user.name", "test"]);
  // Like any real subject repo: node_modules is never committed, so later
  // `git add -A` in tests cannot sweep the symlink source into a commit
  // (which would delete it from the workdir on branch checkout).
  // NOTE: no trailing slash — `node_modules/` does not match a symlink.
  const isPython = existsSync(join(shopSrc, "requirements.txt"));
  writeFileSync(join(repoPath, ".gitignore"), isPython ? "node_modules\n__pycache__\n.venv\n" : "node_modules\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  const base = (await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  const heads: Record<string, string> = {};
  for (const patch of patches) {
    const name = patch.replace(".patch", "");
    await execa("git", ["checkout", "-qb", name], { cwd: repoPath });
    await execa("git", ["apply", join(prsDir, patch)], { cwd: repoPath });
    await git(["add", "-A"]);
    await git(["commit", "-qm", name]);
    heads[name] = (await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await execa("git", ["checkout", "-q", "main"], { cwd: repoPath });
  }
  // Untracked node_modules source so replays exercise the symlink strategy
  // (mirrors the real layout where the subject checkout has installed deps).
  // Python subjects bring no node_modules; their venv is built per worktree.
  if (existsSync(join(shopSrc, "node_modules"))) {
    symlinkSync(join(shopSrc, "node_modules"), join(repoPath, "node_modules"), "dir");
  }
  return { repoPath, base, heads };
}

/** Copy one group's scenario files into a scratch dir for fast subset replays. */
export function subsetScenariosDir(scenariosDir: string, groups: string[], tag: string): string {
  const dir = join(tmpdir(), `rw-scen-${tag}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(scenariosDir)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const s = JSON.parse(readFileSync(join(scenariosDir, f), "utf8")) as { group: string };
    if (groups.includes(s.group)) {
      writeFileSync(join(dir, f), readFileSync(join(scenariosDir, f)));
    }
  }
  return dir;
}

export function cleanup(p: string): void {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
