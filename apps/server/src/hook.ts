import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadOrCreateKey, readNote, verifyReceipt } from "@ripplewitness/receipt";

const execFileP = promisify(execFile);

/** Install a pre-push hook that requires a valid receipt note on HEAD (E-05). */
export function installHook(subjectRepo: string, ripplewitnessRoot: string): string {
  const hookPath = join(subjectRepo, ".git", "hooks", "pre-push");
  writeFileSync(
    hookPath,
    `#!/bin/sh\n# RippleWitness strict mode (E-05). Blocks push without a valid receipt on HEAD.\ncd "${ripplewitnessRoot}" || exit 1\nexec corepack pnpm --filter @ripplewitness/server exec tsx src/cli.ts hook check --repo "${subjectRepo}"\n`,
    { mode: 0o755 },
  );
  return hookPath;
}

/** Verify HEAD carries a receipt note that validates and binds the current diff. */
export async function checkHead(
  subjectRepo: string,
  home: string,
): Promise<{ ok: true; tier: string } | { ok: false; reason: string }> {
  const { stdout: head } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: subjectRepo });
  const note = await readNote(subjectRepo, head.trim());
  if (!note) return { ok: false, reason: "no receipt note on HEAD (run RippleWitness and issue a receipt)" };
  let receipt: unknown;
  try {
    receipt = JSON.parse(note);
  } catch {
    return { ok: false, reason: "receipt note is not valid JSON" };
  }
  const v = verifyReceipt(receipt, loadOrCreateKey(home));
  if (!v.ok) return { ok: false, reason: v.reason };
  // Surface the assurance tier (K-06): verifiers must not present an
  // L0/L1 receipt as execution-backed.
  const tier = (receipt as { payload?: { assuranceTier?: unknown } }).payload?.assuranceTier;
  return { ok: true, tier: typeof tier === "string" ? tier : "unknown (pre-K-06 receipt)" };
}
