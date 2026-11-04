#!/usr/bin/env node
/**
 * Prepare the hosted real-repo subject (docs/HOSTING.md): clone
 * typicode/json-server at the pinned commits, add the disclosed harness
 * files identically to both sides, and install subject dependencies so
 * replay can use the symlink strategy. Idempotent: rebuilds from scratch.
 *
 * Usage: node scripts/prepare-hosted.mjs [destDir]
 * Default dest: $HOSTED_SUBJECT_DIR or /subject/json-server.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_COMMIT = "6ad7562";
const HEAD_COMMIT = "8d42c40";
const dest = process.argv[2] ?? process.env.HOSTED_SUBJECT_DIR ?? "/subject/json-server";

function die(msg) {
  console.error(`\nprepare-hosted: ${msg}`);
  process.exit(1);
}
function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}
function out(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

try {
  run("git", ["--version"], process.cwd());
} catch {
  die("git is required but was not found on PATH.");
}

const harnessDb = join(ROOT, "docs", "real-repo", "rw-db.json");
const harnessSeed = join(ROOT, "docs", "real-repo", "seed", "seed.db");
if (!existsSync(harnessDb) || !existsSync(harnessSeed)) {
  die("docs/real-repo harness files are missing from this checkout.");
}

console.log(`Preparing hosted json-server subject in ${dest} …`);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
run("git", ["clone", "--quiet", "https://github.com/typicode/json-server.git", dest], process.cwd());
const git = (args) => run("git", args, dest);
const commitHarness = (branch, parent) => {
  git(["checkout", "-q", "-B", branch, parent]);
  cpSync(harnessDb, join(dest, "rw-db.json"));
  mkdirSync(join(dest, "seed"), { recursive: true });
  cpSync(harnessSeed, join(dest, "seed", "seed.db"));
  git(["add", "-A"]);
  git(["-c", "user.email=hosted@ripplewitness.local", "-c", "user.name=RippleWitness Hosted", "commit", "-qm", "rw harness (identical on both sides)"]);
};
commitHarness("rw-base", BASE_COMMIT);
commitHarness("rw-head", HEAD_COMMIT);
git(["checkout", "-q", "rw-head"]);

console.log("Installing subject dependencies (symlink strategy needs node_modules)…");
run("corepack", ["pnpm", "install", "--frozen-lockfile"], dest);

console.log("\nHosted subject ready:");
console.log(`  repoPath:     ${dest}`);
console.log("  baseRef:      rw-base");
console.log("  headRef:      rw-head");
console.log(`  scenariosDir: ${join(ROOT, "docs", "real-repo", "scenarios")}`);
console.log("  seedDbRel:    seed/seed.db");
console.log(`\n  head SHA:     ${out("git", ["rev-parse", "HEAD"], dest)}`);
