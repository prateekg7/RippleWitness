import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { aggregateByRoute, createWorktree, diffSteps, loadScenarios, removeWorktree, runReplay } from "@ripplewitness/replay";
import { computeImpact, extractStaticGraph } from "@ripplewitness/graph";
import { verifyClaim } from "@ripplewitness/crossexam";
import { proposeCanary, validateCanary } from "@ripplewitness/canary";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOP = join(ROOT, "demo", "shop-api");
const SCEN = join(ROOT, "demo", "scenarios");
const PRS = join(ROOT, "demo", "prs");

function parseAdded(patch: string): { file: string; lines: number[] }[] {
  const out: { file: string; lines: number[] }[] = [];
  let file = "";
  let nl = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      out.push({ file, lines: [] });
    } else if (line.startsWith("@@ ")) {
      nl = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) {
      out[out.length - 1]?.lines.push(nl);
      nl += 1;
    } else if (file && !line.startsWith("-") && nl > 0) {
      nl += 1;
    }
  }
  return out.filter((f) => f.lines.length > 0);
}

async function main(): Promise<void> {
  const started = Date.now();
  // Subject repo with all catalog branches.
  const repoPath = mkdtempSync(join(tmpdir(), "rw-eval-"));
  cpSync(SHOP, repoPath, { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes(".git") });
  const git = (args: string[]): Promise<string> =>
    execa("git", args, { cwd: repoPath }).then((r) => r.stdout.trim()) as Promise<string>;
  await git(["init", "-q", "-b", "main", "."]);
  await git(["config", "user.email", "eval@local"]);
  await git(["config", "user.name", "eval"]);
  writeFileSync(join(repoPath, ".gitignore"), "node_modules\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  const base = await git(["rev-parse", "HEAD"]);
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(SHOP, "node_modules"), join(repoPath, "node_modules"), "dir");

  const labels = JSON.parse(readFileSync(join(PRS, "labels.json"), "utf8")) as {
    prs: { id: string; patch: string; designed: { observed: string[]; surprise: string[] } }[];
  };
  const scenarios = loadScenarios(SCEN);
  const scenarioRoutes = new Map(scenarios.map((s) => [s.id, s.routeIds]));
  const heads: Record<string, string> = {};
  for (const pr of labels.prs) {
    await git(["checkout", "-qb", pr.id]);
    await execa("git", ["apply", join(PRS, pr.patch)], { cwd: repoPath });
    await git(["add", "-A"]);
    await git(["commit", "-qm", pr.id]);
    heads[pr.id] = await git(["rev-parse", "HEAD"]);
    await git(["checkout", "-q", "main"]);
  }

  const lines: string[] = [
    "# RippleWitness eval results",
    "",
    `Generated: ${new Date().toISOString()} by \`pnpm eval\` (eval/run.ts). Tree: uncommitted working tree.`,
    `Scenarios: ${scenarios.length}. No LLM calls in this harness (deterministic path only).`,
    "",
  ];

  // E1: observed vs designed + static precision/recall per PR.
  lines.push("## E1 — differential replay vs designed labels", "");
  lines.push("| PR | observed (brute-force) | designed observed | match | static-impacted routes |");
  lines.push("|---|---|---|---|---|");
  const e1Evidence: Record<string, { observed: string[]; exercised: string[]; fieldDiffs: Record<string, { path: string; before: unknown; after: unknown }[]>; symbols: string[] }> = {};
  let microTP = 0;
  let microFP = 0;
  let microFN = 0;
  for (const pr of labels.prs) {
    const r = await runReplay({
      repoPath,
      baseRef: base,
      headRef: heads[pr.id] as string,
      scenariosDir: SCEN,
      seedDbRel: "seed/seed.db",
      workRoot: mkdtempSync(join(tmpdir(), `rw-eval-${pr.id}-`)),
    });
    if (!r.ok) {
      lines.push(`| ${pr.id} | REPLAY FAILED (${r.error.stage}) | ${pr.designed.observed.join(", ")} | NO | — |`);
      continue;
    }
    const stepDiffs = r.base.steps.map((s, i) => diffSteps(s, r.head.steps[i] as (typeof r.head.steps)[number]));
    const routeDiffs = aggregateByRoute(stepDiffs, scenarioRoutes);
    const observed = routeDiffs.filter((x) => x.changed).map((x) => x.routeId).sort();
    const exercised = [...new Set(scenarios.flatMap((s) => s.routeIds))].sort();
    // Static set from the head tree.
    const wt = mkdtempSync(join(tmpdir(), `rw-eval-g-${pr.id}-`));
    await execa("rm", ["-rf", wt]);
    await createWorktree(repoPath, heads[pr.id] as string, wt);
    const graph = extractStaticGraph(wt);
    const patch = readFileSync(join(PRS, pr.patch), "utf8");
    const impact = computeImpact(graph, parseAdded(patch));
    await removeWorktree(repoPath, wt);
    const staticRoutes = impact.staticImpacted.filter((id) => id.startsWith("route:")).sort();
    const obsSet = new Set(observed);
    const desSet = new Set(pr.designed.observed);
    const match = observed.length === desSet.size && observed.every((o) => desSet.has(o));
    for (const s of staticRoutes) {
      if (obsSet.has(s)) microTP += 1;
      else microFP += 1;
    }
    for (const o of observed) {
      if (!staticRoutes.includes(o)) microFN += 1;
    }
    e1Evidence[pr.id] = {
      observed,
      exercised,
      fieldDiffs: Object.fromEntries(routeDiffs.map((x) => [x.routeId, x.diffs])),
      symbols: [...graph.nodes.filter((n) => n.kind === "route").map((n) => n.id), ...graph.nodes.filter((n) => n.kind === "service" || n.kind === "handler").map((n) => n.label)],
    };
    lines.push(`| ${pr.id} | ${observed.join(", ") || "∅"} | ${pr.designed.observed.join(", ") || "∅"} | ${match ? "YES" : "**NO**"} | ${staticRoutes.join(", ") || "∅"} |`);
  }
  const precision = microTP + microFP === 0 ? 1 : microTP / (microTP + microFP);
  const recall = microTP + microFN === 0 ? 1 : microTP / (microTP + microFN);
  lines.push("", `Static-vs-observed micro-average: precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)} (TP ${microTP}, FP ${microFP}, FN ${microFN}).`, "");

  // E2: determinism double-run + cost.
  const d1 = await runReplay({ repoPath, baseRef: base, headRef: base, scenariosDir: SCEN, seedDbRel: "seed/seed.db", workRoot: mkdtempSync(join(tmpdir(), "rw-eval-d1-")) });
  const d2 = await runReplay({ repoPath, baseRef: base, headRef: base, scenariosDir: SCEN, seedDbRel: "seed/seed.db", workRoot: mkdtempSync(join(tmpdir(), "rw-eval-d2-")) });
  const detSame = d1.ok && d2.ok && JSON.stringify(d1.base.steps) === JSON.stringify(d2.base.steps);
  lines.push("## E2 — determinism + cost", "");
  lines.push(`- Base-vs-base full replay twice byte-identical: **${detSame ? "YES" : "NO"}**`);
  lines.push("- LLM calls in deterministic path: 0 ($0). Review-time LLM calls are capped per run (NFR-05) and unmeasured here.");
  lines.push("");

  // E3: seeded claims vs brute-force evidence.
  const claimsDoc = JSON.parse(readFileSync(join(PRS, "claims.json"), "utf8")) as {
    claims: { id: string; pr: string; text: string; type: string; params: { routes?: string[]; symbol?: string; route?: string; breaking?: boolean }; expected: string }[];
  };
  lines.push("## E3 — claim verifier accuracy (20 seeded)", "");
  lines.push("| claim | PR | expected | got |");
  lines.push("|---|---|---|---|");
  let correct = 0;
  let falseContra = 0;
  for (const c of claimsDoc.claims) {
    const evd = e1Evidence[c.pr];
    let got = "NO-EVIDENCE";
    if (evd) {
      const res = verifyClaim(
        {
          id: c.id,
          type: c.type as "SCOPE",
          text: c.text,
          routes: c.params.routes ?? [],
          ...(c.params.symbol ? { symbol: c.params.symbol } : {}),
          ...(c.params.route ? { route: c.params.route } : {}),
          ...(c.params.breaking === undefined ? {} : { breaking: c.params.breaking }),
        },
        {
          observedChanged: new Set(evd.observed),
          exercised: new Set(evd.exercised),
          headSymbols: new Set(evd.symbols),
          fieldDiffs: new Map(Object.entries(evd.fieldDiffs)),
        },
      );
      got = res.verdict;
    }
    if (got === c.expected) correct += 1;
    if (got === "CONTRADICTED" && c.expected !== "CONTRADICTED") falseContra += 1;
    lines.push(`| ${c.id} | ${c.pr} | ${c.expected} | ${got === c.expected ? got : `**${got}**`} |`);
  }
  lines.push("", `Accuracy: ${correct}/20. False CONTRADICTED: ${falseContra} (target ≤10%, i.e. ≤2).`, "");

  // E5: canary execution validation once.
  const headWt = mkdtempSync(join(tmpdir(), "rw-eval-can-"));
  await execa("rm", ["-rf", headWt]);
  await createWorktree(repoPath, base, headWt);
  const appSrc = readFileSync(join(headWt, "src", "app.ts"), "utf8");
  await removeWorktree(repoPath, headWt);
  const cand = proposeCanary(appSrc, "src/app.ts");
  let canaryLine = "no candidate proposed";
  if (cand) {
    const v = await validateCanary({ repoPath, baseRef: base, candidate: cand, scenariosDir: SCEN, seedDbRel: "seed/seed.db", workRoot: mkdtempSync(join(tmpdir(), "rw-eval-canv-")) });
    canaryLine = `${cand.operator} @${cand.file}:${cand.line} → ${v.accepted ? "ACCEPTED" : "REJECTED"} (${v.reason}; routes: ${v.changedRoutes.join(", ") || "∅"})`;
  }
  lines.push("## E5 — canary execution validation (single attempt)", "", `- ${canaryLine}`, "- Catch rate needs human trials; not measured here.", "");
  lines.push(`Harness wall time: ${((Date.now() - started) / 1000).toFixed(0)}s.`);
  writeFileSync(join(ROOT, "eval", "results.md"), lines.join("\n"));
  console.log(`wrote eval/results.md in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

await main();
