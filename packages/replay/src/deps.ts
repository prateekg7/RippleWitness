import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

export type DepStrategy = "symlink" | "install" | "none";

function manifestHash(dir: string): string {
  const h = createHash("sha256");
  for (const f of ["package.json", "pnpm-lock.yaml", "package-lock.json", "requirements.txt", "pyproject.toml", "go.mod", "go.sum"]) {
    const p = join(dir, f);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest("hex");
}

/**
 * Discover the node start command from `package.json` (F-18): when the subject
 * declares `scripts.start`, replay uses the package manager start; otherwise
 * null (caller falls back to its default). Never throws.
 */
/**
 * How to invoke pnpm for subject lifecycle (boot + frozen install).
 * Prefers a `pnpm` already on PATH (CI via pnpm/action-setup disables
 * corepack, so bare `corepack pnpm` fails there); falls back to corepack
 * on machines where pnpm is only available through it. Never throws.
 */
export function pnpmLauncher(): string[] {
  try {
    const r = spawnSync("pnpm", ["--version"], { stdio: "ignore", timeout: 10000 });
    if (r.status === 0) return ["pnpm"];
  } catch {
    /* fall through */
  }
  return ["corepack", "pnpm"];
}

export function discoverStartCommand(appDir: string): string[] | null {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { scripts?: { start?: unknown } };
    return typeof pkg.scripts?.start === "string" && pkg.scripts.start.length > 0 ? [...pnpmLauncher(), "start"] : null;
  } catch {
    return null;
  }
}

/** Discover the Go start command from `go.mod` (roadmap): `go run .`. Never throws. */
export function discoverGoStartCommand(appDir: string): string[] | null {
  try {
    return existsSync(join(appDir, "go.mod")) ? ["go", "run", "."] : null;
  } catch {
    return null;
  }
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
  opts: { language?: "node" | "python" | "go" } = {},
): Promise<{ strategy: DepStrategy; elapsedMs: number }> {
  const started = Date.now();
  if (opts.language === "python") return ensurePythonDeps(worktreeDir, started);
  if (opts.language === "go") return ensureGoDeps(worktreeDir, started);
  const link = join(worktreeDir, "node_modules");
  // A subject repo may itself commit node_modules (a real directory, not
  // our symlink): unlink() cannot remove it, so delete recursively.
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  if (baseHash === headHash && existsSync(join(sourceDir, "node_modules"))) {
    symlinkSync(join(sourceDir, "node_modules"), link, "dir");
    return { strategy: "symlink", elapsedMs: Date.now() - started };
  }
  const launcher = pnpmLauncher();
  await execa(launcher[0] as string, [...launcher.slice(1), "install", "--frozen-lockfile"], {
    cwd: worktreeDir,
    timeout: 120000,
  });
  return { strategy: "install", elapsedMs: Date.now() - started };
}

/**
 * Python lifecycle (J-04): stdlib-only subjects need nothing (`none`); subjects
 * with `requirements.txt` get a worktree-local venv + pip install (`install`).
 * The venv lives at `<worktree>/.venv`; the runner prepends its bin to PATH.
 */
async function ensurePythonDeps(worktreeDir: string, started: number): Promise<{ strategy: DepStrategy; elapsedMs: number }> {
  const req = join(worktreeDir, "requirements.txt");
  if (!existsSync(req)) return { strategy: "none", elapsedMs: Date.now() - started };
  const venv = join(worktreeDir, ".venv");
  await execa("python3", ["-m", "venv", venv], { cwd: worktreeDir, timeout: 120000 });
  await execa(join(venv, "bin", "pip"), ["install", "--disable-pip-version-check", "-r", req], {
    cwd: worktreeDir,
    timeout: 300000,
  });
  return { strategy: "install", elapsedMs: Date.now() - started };
}

/**
 * Go lifecycle: stdlib-only subjects need nothing (`none`; `go run` builds on
 * demand). Subjects with `require` directives get `go mod download` (`install`).
 */
async function ensureGoDeps(worktreeDir: string, started: number): Promise<{ strategy: DepStrategy; elapsedMs: number }> {
  let mod = "";
  try {
    mod = readFileSync(join(worktreeDir, "go.mod"), "utf8");
  } catch {
    return { strategy: "none", elapsedMs: Date.now() - started };
  }
  if (!/^\s*require\s/m.test(mod)) return { strategy: "none", elapsedMs: Date.now() - started };
  await execa("go", ["mod", "download"], { cwd: worktreeDir, timeout: 300000 });
  return { strategy: "install", elapsedMs: Date.now() - started };
}

export function hashManifests(dir: string): string {
  return manifestHash(dir);
}
