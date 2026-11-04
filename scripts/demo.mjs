#!/usr/bin/env node
/**
 * One-command demo (docs/DEMO.md): prepare the PR-00 hero subject in a
 * scratch repo, then start the RippleWitness server + web UI in the
 * foreground. Ctrl+C stops both.
 *
 * Usage: corepack pnpm demo [patch]     (default patch: PR-00)
 */
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const patch = process.argv[2] ?? "PR-00";
const SHOP = join(ROOT, "demo", "shop-api");

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function die(msg) {
  console.error(`\nripplewitness demo: ${msg}`);
  process.exit(1);
}

// Preflight: fail loudly and helpfully, never half-start.
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 22) {
  die(`Node >= 22 is required (found ${process.version}). Install Node 22, then rerun.`);
}
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  die("git is required but was not found on PATH.");
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}
for (const port of [4400, 5173]) {
  if (!(await portFree(port))) {
    die(`port ${port} is already in use. Stop the other process, then rerun.`);
  }
}

if (!existsSync(join(SHOP, "node_modules"))) {
  die("demo/shop-api has no node_modules. Run `corepack pnpm i` first.");
}

console.log("Seeding demo database…");
run("corepack", ["pnpm", "demo:prepare"], ROOT);

const subj = join(tmpdir(), `rw-demo-${patch.toLowerCase()}`);
console.log(`Preparing hero subject in ${subj} …`);
// Our own scratch dir from a previous run: rebuild from scratch so the
// demo is re-runnable (a second run must not fail on the old git repo).
rmSync(subj, { recursive: true, force: true });
mkdirSync(subj, { recursive: true });
cpSync(SHOP, subj, {
  recursive: true,
  filter: (s) => !s.includes("node_modules") && !s.includes(".git"),
});
const git = (args) => run("git", args, subj);
git(["init", "-q", "-b", "main", "."]);
git(["config", "user.email", "demo@local"]);
git(["config", "user.name", "demo"]);
writeFileSync(join(subj, ".gitignore"), "node_modules\n");
git(["add", "-A"]);
git(["commit", "-qm", "base"]);
git(["checkout", "-q", "-b", "pr"]);
git(["apply", join(ROOT, "demo", "prs", `${patch}.patch`)]);
git(["add", "-A"]);
git(["commit", "-qm", "pr"]);
git(["checkout", "-q", "main"]);
symlinkSync(join(SHOP, "node_modules"), join(subj, "node_modules"), "dir");

console.log("\nStarting RippleWitness (server :4400, web :5173). Ctrl+C stops both.\n");
console.log("In the UI (New review):");
console.log(`  Repo:         ${subj}`);
console.log("  Base:         main");
console.log("  Head:         pr");
console.log(`  Scenarios:    ${join(ROOT, "demo", "scenarios")}`);
console.log("  Seed DB:      seed/seed.db");
console.log("\nDemo beats: docs/DEMO.md\n");

const children = [];
function start(cmd, args, env) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`${cmd} exited with ${code}`);
      shutdown();
    }
  });
  return child;
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      c.kill("SIGINT");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start("corepack", ["pnpm", "--filter", "@ripplewitness/server", "run", "dev"], {
  RIPPLEWITNESS_PORT: "4400",
});
start("corepack", ["pnpm", "--filter", "@ripplewitness/web", "run", "dev"], {});
