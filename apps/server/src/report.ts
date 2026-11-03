import type Database from "better-sqlite3";
import type { FusedNode } from "@ripplewitness/core";
import { trailerValue } from "@ripplewitness/receipt";
import type { SignedEdReceipt, SignedReceipt } from "@ripplewitness/receipt";
import { getArtifact } from "./store.js";

/**
 * PR-bot report mode (M-09). Deterministic markdown rendered from stored
 * artifacts only — no LLM, no agent prose. A bot posts the output as a PR
 * comment; the endpoint sits behind requireLock so nothing leaks pre-lock.
 */

const MAX_ROUTES = 50;
const MAX_CLAIMS = 30;
const MAX_QUESTIONS = 10;

function esc(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderReport(
  db: Database.Database,
  runId: string,
): { ok: true; markdown: string } | { ok: false; status: number; error: string } {
  const run = db.prepare("SELECT repoPath, baseRef, headRef, status, prediction, score, locked, overrideReason FROM runs WHERE id = ?").get(runId) as
    | {
        repoPath: string;
        baseRef: string;
        headRef: string;
        status: string;
        prediction: string | null;
        score: string | null;
        locked: number;
        overrideReason: string | null;
      }
    | undefined;
  if (!run) return { ok: false, status: 404, error: "not_found" };
  if (!run.locked) return { ok: false, status: 423, error: "prediction_locked_required" };

  const fused = (getArtifact<FusedNode[]>(db, runId, "fused") ?? []).slice().sort((a, b) => (a.routeId < b.routeId ? -1 : 1));
  const claims = getArtifact<{ claimId: string; verdict: string }[]>(db, runId, "claims") ?? [];
  const questions = db.prepare("SELECT id, routeId, status, template FROM questions WHERE runId = ? ORDER BY id").all(runId) as {
    id: string;
    routeId: string | null;
    status: string;
    template: string;
  }[];
  const receipt = getArtifact<SignedReceipt | SignedEdReceipt>(db, runId, "receipt");
  const reviewMode = getArtifact<string>(db, runId, "reviewMode") ?? "full";
  const tier = getArtifact<string>(db, runId, "assuranceTier") ?? "unknown";
  const score = run.score ? (JSON.parse(run.score) as { recall: number; precision: number; passed: boolean; passReason: string }) : null;

  const short = (s: string): string => s.slice(0, 8);
  const lines: string[] = [];
  lines.push(`## RippleWitness report — \`${esc(short(run.baseRef))}..${esc(short(run.headRef))}\``);
  lines.push("");
  lines.push(`Status: **${esc(run.status)}** · mode: ${esc(reviewMode)} · assurance: **${esc(tier)}**`);
  lines.push("");
  lines.push("### Gate");
  lines.push("");
  if (!score) {
    lines.push("Not scored yet.");
  } else {
    lines.push(`**${score.passed ? "PASS" : "FAIL"}** — recall ${score.recall.toFixed(2)}, precision ${score.precision.toFixed(2)} (${esc(score.passReason)})`);
    if (run.overrideReason) lines.push(`Override: ${esc(run.overrideReason)}`);
  }
  lines.push("");
  lines.push("### Observed blast radius");
  lines.push("");
  if (fused.length === 0) {
    lines.push("No fused routes.");
  } else {
    lines.push("| route | status | exercised | static | surprise |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const n of fused.slice(0, MAX_ROUTES)) {
      lines.push(`| ${esc(n.routeId)} | ${n.status} | ${n.exercised ? "yes" : "no"} | ${n.staticImpacted ? "yes" : "no"} | ${n.surprise ? "yes" : "no"} |`);
    }
    if (fused.length > MAX_ROUTES) lines.push(`_…and ${fused.length - MAX_ROUTES} more._`);
  }
  const unverified = fused.filter((n) => n.status === "UNVERIFIED" || n.status === "UNCOVERED").map((n) => n.routeId);
  lines.push("");
  lines.push("### Unverified");
  lines.push("");
  lines.push(unverified.length === 0 ? "None — every fused route was exercised." : unverified.map((r) => `- \`${esc(r)}\``).join("\n"));
  lines.push("");
  lines.push("### Claims");
  lines.push("");
  if (claims.length === 0) {
    lines.push("No extracted claims.");
  } else {
    lines.push("| claim | verdict |");
    lines.push("| --- | --- |");
    for (const c of claims.slice(0, MAX_CLAIMS)) lines.push(`| ${esc(c.claimId)} | ${esc(c.verdict)} |`);
    if (claims.length > MAX_CLAIMS) lines.push(`_…and ${claims.length - MAX_CLAIMS} more._`);
  }
  const open = questions.filter((q) => q.status === "OPEN" || q.status === "CONTESTED");
  lines.push("");
  lines.push("### Open questions");
  lines.push("");
  if (open.length === 0) {
    lines.push("None.");
  } else {
    for (const q of open.slice(0, MAX_QUESTIONS)) {
      lines.push(`- **${esc(q.id)}** [${esc(q.status)}]${q.routeId ? ` \`${esc(q.routeId)}\`` : ""} — ${esc(q.template.split("\n")[0] ?? "")}`);
    }
    if (open.length > MAX_QUESTIONS) lines.push(`_…and ${open.length - MAX_QUESTIONS} more._`);
  }
  lines.push("");
  lines.push("---");
  if (tier === "L0") lines.push("_Tier L0: replay failed or static-only — treat this report as weak evidence._");
  if (receipt) lines.push(`\`${trailerValue(receipt)}\``);
  lines.push("_Rendered from observed evidence. Agent prose is never evidence._");
  lines.push("");
  return { ok: true, markdown: lines.join("\n") };
}
