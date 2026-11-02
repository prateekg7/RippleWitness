import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runDoctor } from "./doctor.js";

const cmd = process.argv[2] ?? "help";
const home = process.env.RIPPLEWITNESS_HOME ?? join(process.cwd(), ".ripplewitness");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (cmd === "doctor") {
  const checks = await runDoctor();
  for (const c of checks) {
    console.log(`${c.ok ? "ok  " : "warn"} ${c.name}: ${c.detail}`);
  }
  const fatal = checks.filter((c) => !c.ok && (c.name === "node" || c.name === "git"));
  process.exit(fatal.length > 0 ? 1 : 0);
} else if (cmd === "serve") {
  const { start } = await import("./serve.js");
  start();
} else if (cmd === "verify") {
  const file = flag("--receipt");
  if (!file) {
    console.error("Usage: ripplewitness verify --receipt <file>");
    process.exit(2);
  }
  const { loadOrCreateKey, verifyReceipt } = await import("@ripplewitness/receipt");
  const out = verifyReceipt(JSON.parse(readFileSync(file, "utf8")), loadOrCreateKey(home));
  console.log(out.ok ? "VALID" : `INVALID: ${(out as { reason: string }).reason}`);
  process.exit(out.ok ? 0 : 1);
} else if (cmd === "hook") {
  const sub = process.argv[3];
  const { checkHead, installHook } = await import("./hook.js");
  if (sub === "install") {
    const repo = flag("--repo");
    if (!repo) {
      console.error("Usage: ripplewitness hook install --repo <subject-repo>");
      process.exit(2);
    }
    console.log(installHook(repo, process.cwd()));
  } else if (sub === "check") {
    const repo = flag("--repo") ?? process.cwd();
    const out = await checkHead(repo, home);
    console.log(out.ok ? "receipt OK" : `blocked: ${(out as { reason: string }).reason}`);
    process.exit(out.ok ? 0 : 1);
  } else {
    console.error("Usage: ripplewitness hook <install|check> --repo <path>");
    process.exit(2);
  }
} else {
  console.log("Usage: ripplewitness <doctor|serve|verify|hook>");
}
