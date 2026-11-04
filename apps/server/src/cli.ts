import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envText } from "@ripplewitness/agents";
import { runDoctor } from "./doctor.js";

const cmd = process.argv[2] ?? "help";
const home = envText(process.env.RIPPLEWITNESS_HOME) ?? join(process.cwd(), ".ripplewitness");

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
    console.error("Usage: ripplewitness verify --receipt <file> [--public-key <pem>]");
    process.exit(2);
  }
  const { loadOrCreateKey, verifyReceiptAny } = await import("@ripplewitness/receipt");
  const receipt = JSON.parse(readFileSync(file, "utf8")) as { payload?: { assuranceTier?: unknown } };
  const pubFile = flag("--public-key");
  const out = verifyReceiptAny(receipt, {
    hmacKey: loadOrCreateKey(home),
    ...(pubFile ? { publicKeyPem: readFileSync(pubFile, "utf8") } : {}),
  });
  const tier = out.ok ? (typeof receipt.payload?.assuranceTier === "string" ? receipt.payload.assuranceTier : "unknown (pre-K-06 receipt)") : null;
  console.log(out.ok ? `VALID tier:${tier as string}` : `INVALID: ${(out as { reason: string }).reason}`);
  process.exit(out.ok ? 0 : 1);
} else if (cmd === "draft-scenarios") {
  const routesFlag = flag("--routes");
  const out = flag("--out");
  if (!routesFlag || !out) {
    console.error("Usage: ripplewitness draft-scenarios --routes <file.json|id,id,...> --out <dir>");
    process.exit(2);
  }
  let routes: string[];
  if (routesFlag.endsWith(".json")) {
    const parsed = JSON.parse(readFileSync(routesFlag, "utf8")) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((r): r is string => typeof r === "string")) {
      console.error("routes file must be a JSON array of route ids");
      process.exit(2);
    }
    routes = parsed;
  } else {
    routes = routesFlag.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const { runDraft } = await import("./draft.js");
  const result = runDraft(routes, out);
  if (!result.ok) {
    console.error(`draft failed: ${(result as { error: string }).error}`);
    process.exit(1);
  }
  for (const f of (result as { files: string[] }).files) console.log(f);
} else if (cmd === "import-har") {
  const harFile = flag("--har");
  const out = flag("--out");
  if (!harFile || !out) {
    console.error("Usage: ripplewitness import-har --har <file.har> --out <dir> [--base-url <origin>] [--group <name>]");
    process.exit(2);
  }
  const { writeHarScenarios } = await import("@ripplewitness/replay");
  const result = writeHarScenarios(JSON.parse(readFileSync(harFile, "utf8")) as unknown, out, {
    ...(flag("--base-url") ? { baseUrl: flag("--base-url") as string } : {}),
    ...(flag("--group") ? { group: flag("--group") as string } : {}),
  });
  if (!result.ok) {
    console.error(`import-har failed: ${(result as { error: string }).error}`);
    process.exit(1);
  }
  for (const f of (result as { files: string[] }).files) console.log(f);
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
    console.log(out.ok ? `receipt OK tier:${out.tier}` : `blocked: ${(out as { reason: string }).reason}`);
    process.exit(out.ok ? 0 : 1);
  } else {
    console.error("Usage: ripplewitness hook <install|check> --repo <path>");
    process.exit(2);
  }
} else {
  console.log("Usage: ripplewitness <doctor|serve|verify|hook|draft-scenarios|import-har>");
}
