#!/usr/bin/env node
/**
 * RippleWitness CI receipt verifier (F-13). Zero dependencies: copy this file
 * (or use ci-action/action.yml) into a subject repo's CI.
 *
 * Checks, in order:
 *   1. HEAD carries a git note at refs/notes/ripplewitness with JSON.
 *   2. The receipt signature validates — dispatched on receipt shape:
 *      HMAC receipts under RIPPLEWITNESS_KEY_HEX (repo secret provisioned
 *      from the reviewer's `.ripplewitness/key` via `xxd -p`); ed25519
 *      receipts under RIPPLEWITNESS_PUBKEY_PEM (repo variable holding the
 *      reviewer's `.ripplewitness/signing.pub` — public, safe to expose).
 *   3. receipt.headRef equals the checked-out HEAD.
 *   4. receipt.diffHash equals sha256(git diff baseRef..HEAD).
 *
 * Prints VALID tier:<L0-L3> (or the assurance tier caveat) and exits 0;
 * otherwise prints the reason and exits 1.
 * Out of scope: scenarioHash (scenarios live in the reviewer's checkout,
 * not the subject repo) and artifact re-hashing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac, timingSafeEqual, verify } from "node:crypto";

const execFileP = promisify(execFile);
const NOTES_REF = "refs/notes/ripplewitness";

async function git(args, cwd) {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function fail(reason) {
  console.log(`INVALID: ${reason}`);
  process.exitCode = 1;
}

async function main() {
  const repo = process.argv[2] ?? process.cwd();
  let head;
  try {
    head = (await git(["rev-parse", "HEAD"], repo)).trim();
  } catch {
    fail("not a git checkout");
    return;
  }
  let note = null;
  try {
    note = (await git(["notes", `--ref=${NOTES_REF}`, "show", head], repo)).trim() || null;
  } catch {
    note = null;
  }
  if (!note) {
    fail("no receipt note on HEAD (run RippleWitness and issue a receipt)");
    return;
  }
  let receipt;
  try {
    receipt = JSON.parse(note);
  } catch {
    fail("receipt note is not valid JSON");
    return;
  }
  if (!receipt || typeof receipt !== "object" || !receipt.payload) {
    fail("malformed_receipt");
    return;
  }
  const canonical = JSON.stringify(receipt.payload);
  if (receipt.alg === "ed25519") {
    const pubPem = process.env.RIPPLEWITNESS_PUBKEY_PEM ?? "";
    if (!pubPem.includes("BEGIN PUBLIC KEY")) {
      fail("RIPPLEWITNESS_PUBKEY_PEM must hold the reviewer's signing.pub PEM");
      return;
    }
    let ok = false;
    try {
      ok = verify(null, Buffer.from(canonical, "utf8"), pubPem, Buffer.from(receipt.signature, "hex"));
    } catch {
      fail("malformed_receipt");
      return;
    }
    if (!ok) {
      fail("signature_mismatch");
      return;
    }
  } else if (typeof receipt.hmac === "string") {
    const keyHex = process.env.RIPPLEWITNESS_KEY_HEX ?? "";
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      fail("RIPPLEWITNESS_KEY_HEX must be the 32-byte key as 64 hex chars");
      return;
    }
    const key = Buffer.from(keyHex, "hex");
    const expected = createHmac("sha256", key).update(canonical, "utf8").digest("hex");
    const a = Buffer.from(expected, "hex");
    let b;
    try {
      b = Buffer.from(receipt.hmac, "hex");
    } catch {
      fail("hmac_mismatch");
      return;
    }
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      fail("hmac_mismatch");
      return;
    }
  } else {
    fail("malformed_receipt");
    return;
  }
  if (receipt.payload.headRef !== head) {
    fail(`head_mismatch: receipt binds ${receipt.payload.headRef}, checkout is ${head}`);
    return;
  }
  let diff;
  try {
    diff = await git(["diff", receipt.payload.baseRef, head], repo);
  } catch {
    fail(`unknown baseRef ${receipt.payload.baseRef}`);
    return;
  }
  const diffHash = createHash("sha256").update(diff).digest("hex");
  if (diffHash !== receipt.payload.diffHash) {
    fail("diffHash_mismatch: the diff changed after the receipt was issued");
    return;
  }
  const tier = receipt.payload.assuranceTier;
  console.log(`VALID tier:${typeof tier === "string" ? tier : "unknown (pre-K-06 receipt)"}`);
}

await main();
