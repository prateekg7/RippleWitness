import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { loadOrCreateKey, loadOrCreateSignKey, signReceipt, signReceiptEd, writeNote } from "@ripplewitness/receipt";
import type { ReceiptPayload, SignedEdReceipt, SignedReceipt } from "@ripplewitness/receipt";
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

/**
 * Receipts bind resolved SHAs, not ref spellings: a receipt issued for a
 * branch name must still verify in a CI clone that only has the commit.
 * Unresolvable refs keep their spelling (verification then fails loudly).
 */
export async function resolveRef(repoPath: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", ref], { cwd: repoPath });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : ref;
  } catch {
    return ref;
  }
}

/** Max artifact file size hashed into a receipt (F-25); larger files are recorded, not hashed. */
export const ARTIFACT_SIZE_CAP = 256 * 1024 * 1024;

export function tierForReviewMode(mode: string): "L0" | "L1" | "L2" | "L3" {
  // static-only is conservatively L0 (replay failed — may not even boot);
  // dynamic-only has deterministic replay but no static claims (L2).
  if (mode === "dynamic-only") return "L2";
  if (mode === "static-only") return "L0";
  return "L3";
}

/**
 * Hash subject-declared artifact files (model weights, datasets) from a tree.
 * Paths must be repo-relative inside `appRoot`; absolute/`..`/missing/oversize
 * entries are recorded with a reason, never hashed. Pure I/O, never throws.
 */
export function hashArtifactFiles(appRoot: string, relPaths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const root = resolve(appRoot) + sep;
  for (const rel of relPaths) {
    if (rel.startsWith("/") || !resolve(appRoot, rel).startsWith(root)) {
      out[rel] = "rejected:escapes-app-root";
      continue;
    }
    const abs = join(appRoot, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        out[rel] = "missing:not-a-file";
        continue;
      }
      if (st.size > ARTIFACT_SIZE_CAP) {
        out[rel] = `too-large:${st.size}`;
        continue;
      }
      out[rel] = `sha256:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
    } catch {
      out[rel] = "missing:unreadable";
    }
  }
  return out;
}

export async function issueReceipt(
  db: Database.Database,
  home: string,
  runId: string,
  opts?: { algorithm?: "hmac" | "ed25519" },
): Promise<{ ok: true; receipt: SignedReceipt | SignedEdReceipt } | { ok: false; status: number; error: string }> {
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
  // Honesty (AGENTS C6): the receipt records how answers actually arrived,
  // never a hardcoded mode. Answers stored before modes were persisted came
  // from the stub session, which self-labels reinstantiated_from_transcript.
  const asked = db.prepare("SELECT answer FROM questions WHERE runId = ? AND askedCount > 0").all(runId) as { answer: string | null }[];
  const answeredModes = asked
    .map((q) => {
      try {
        return (JSON.parse(q.answer ?? "{}") as { mode?: unknown }).mode;
      } catch {
        return undefined;
      }
    })
    .filter((m): m is string => typeof m === "string");
  const agentMode =
    asked.length === 0 ? "not_asked" : answeredModes.includes("live_session") ? "live_session" : "reinstantiated_from_transcript";
  const runStatus = (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
  const reviewMode = getArtifact<string>(db, runId, "reviewMode") ?? (runStatus === "ready" ? "full" : "static-only");
  const baseSha = await resolveRef(run.repoPath, run.baseRef);
  const headSha = await resolveRef(run.repoPath, run.headRef);
  const payload: ReceiptPayload = {
    runId,
    baseRef: baseSha,
    headRef: headSha,
    diffHash: await hashDiff(run.repoPath, baseSha, headSha),
    scenarioHash: hashScenariosDir(inputs.scenariosDir),
    prediction: JSON.parse(run.prediction),
    score,
    overrideReason: run.overrideReason,
    claims: claims.map((c) => ({ claimId: c.claimId, verdict: c.verdict })),
    questions: questions.map((q) => ({ id: q.id, status: q.status })),
    agentMode,
    createdAt: new Date().toISOString(),
    assuranceTier: tierForReviewMode(reviewMode),
    artifactHashes: getArtifact<Record<string, string>>(db, runId, "artifactHashes") ?? {},
  };
  const receipt =
    opts?.algorithm === "ed25519"
      ? signReceiptEd(payload, loadOrCreateSignKey(home).privateKeyPem)
      : signReceipt(payload, loadOrCreateKey(home));
  putArtifact(db, runId, "receipt", receipt);
  await writeNote(run.repoPath, run.headRef, JSON.stringify(receipt));
  return { ok: true, receipt };
}
