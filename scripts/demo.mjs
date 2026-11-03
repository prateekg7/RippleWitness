#!/usr/bin/env node
/**
 * One-command demo (docs/DEMO.md): prepare the PR-00 hero subject in a
 * scratch repo, then start the RippleWitness server + web UI in the
 * foreground. Ctrl+C stops both.
 *
 * Usage: corepack pnpm demo [patch]     (default patch: PR-00)
 */
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

if (!existsSync(join(SHOP, "node_modules"))) {
  console.error("demo/shop-api has no node_modules. Run `corepack pnpm i` first.");
  process.exit(1);
}

console.log("Seeding demo database…");
run("corepack", ["pnpm", "demo:prepare"], ROOT);

const subj = join(tmpdir(), `rw-demo-${patch.toLowerCase()}`);
console.log(`Preparing hero subject in ${subj} …`);
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
