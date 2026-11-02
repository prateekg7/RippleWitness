import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { loadOrCreateKey, signReceipt, writeNote } from "@ripplewitness/receipt";
import type { ReceiptPayload, SignedReceipt } from "@ripplewitness/receipt";
import { getArtifact, putArtifact } from "./store.js";

const execFileP = promisify(execFile);

export function hashScenariosDir(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    h.update(f);
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest("hex");
}

export async function hashDiff(repoPath: string, baseRef: string, headRef: string): Promise<string> {
  const { stdout } = await execFileP("git", ["diff", baseRef, headRef], { cwd: repoPath, maxBuffer: 64 * 1024 * 1024 });
  return createHash("sha256").update(stdout).digest("hex");
}

export async function issueReceipt(
  db: Database.Database,
  home: string,
  runId: string,
): Promise<{ ok: true; receipt: SignedReceipt } | { ok: false; status: number; error: string }> {
  const run = db.prepare("SELECT id, repoPath, baseRef, headRef, prediction, score, locked, overrideReason FROM runs WHERE id = ?").get(runId) as
    | { id: string; repoPath: string; baseRef: string; headRef: string; prediction: string; score: string; locked: number; overrideReason: string | null }
    | undefined;
  if (!run) return { ok: false, status: 404, error: "not_found" };
  if (!run.locked) return { ok: false, status: 423, error: "prediction_locked_required" };
  const score = JSON.parse(run.score) as { recall: number; precision: number; passed: boolean; passReason: string };
  if (!score.passed && !run.overrideReason) return { ok: false, status: 409, error: "gate_not_passed" };
  const inputs = getArtifact<{ scenariosDir: string }>(db, runId, "inputs");
  if (!inputs) return { ok: false, status: 409, error: "inputs_missing" };
  const claims = getArtifact<{ claimId: string; verdict: string }[]>(db, runId, "claims") ?? [];
  const questions = db.prepare("SELECT id, status FROM questions WHERE runId = ?").all(runId) as { id: string; status: string }[];
  const payload: ReceiptPayload = {
    runId,
    baseRef: run.baseRef,
    headRef: run.headRef,
    diffHash: await hashDiff(run.repoPath, run.baseRef, run.headRef),
    scenarioHash: hashScenariosDir(inputs.scenariosDir),
    prediction: JSON.parse(run.prediction),
    score,
    overrideReason: run.overrideReason,
    claims: claims.map((c) => ({ claimId: c.claimId, verdict: c.verdict })),
    questions: questions.map((q) => ({ id: q.id, status: q.status })),
    agentMode: "live_session",
    createdAt: new Date().toISOString(),
  };
  const receipt = signReceipt(payload, loadOrCreateKey(home));
  putArtifact(db, runId, "receipt", receipt);
  await writeNote(run.repoPath, run.headRef, JSON.stringify(receipt));
  return { ok: true, receipt };
}
