import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signReceipt, signReceiptEd } from "./receipt.js";
import { loadOrCreateSignKey } from "./key.js";
import { NOTES_REF } from "./gitnotes.js";

const exec = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ci-action", "verify-receipt.mjs");

async function scratch(): Promise<{ repo: string; base: string; head: string; key: Buffer }> {
  const repo = mkdtempSync(join(tmpdir(), "rw-ci-"));
  await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
  await exec("git", ["config", "user.email", "t@l"], { cwd: repo });
  await exec("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "a\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "base"], { cwd: repo });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  writeFileSync(join(repo, "f.txt"), "b\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "head"], { cwd: repo });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  return { repo, base, head, key: randomBytes(32) };
}

function payloadFor(base: string, head: string, diffHash: string) {
  return {
    runId: "r1",
    baseRef: base,
    headRef: head,
    diffHash,
    scenarioHash: "s",
    prediction: {},
    score: { recall: 1, precision: 1, passed: true, passReason: "x" },
    overrideReason: null,
    claims: [],
    questions: [],
    agentMode: "live_session",
    createdAt: "2026-01-01T00:00:00Z",
    assuranceTier: "L3" as const,
    artifactHashes: {},
  };
}

async function run(repo: string, keyHex: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await exec("node", [SCRIPT, repo], {
      env: { ...process.env, RIPPLEWITNESS_KEY_HEX: keyHex, ...extraEnv },
    });
    return { code: 0, out: stdout.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: String(e.stdout ?? "").trim() };
  }
}

describe("CI receipt verifier F-13 (CT-CI-01)", () => {
  it("accepts a bound receipt, rejects tampering", async () => {
    const { repo, base, head, key } = await scratch();
    const diff = (await exec("git", ["diff", base, head], { cwd: repo })).stdout;
    const diffHash = createHash("sha256").update(diff).digest("hex");
    const receipt = signReceipt(payloadFor(base, head, diffHash), key);
    await exec("git", ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", JSON.stringify(receipt), head], { cwd: repo });
    const hex = key.toString("hex");
    await expect(run(repo, hex)).resolves.toEqual({ code: 0, out: "VALID tier:L3" });
    // Wrong key.
    const bad = await run(repo, randomBytes(32).toString("hex"));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("hmac_mismatch");
    // Receipt binding a different diff.
    const forged = signReceipt(payloadFor(base, head, "0".repeat(64)), key);
    await exec("git", ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", JSON.stringify(forged), head], { cwd: repo });
    const tampered = await run(repo, hex);
    expect(tampered.code).toBe(1);
    expect(tampered.out).toContain("diffHash_mismatch");
  });

  it("fails loudly with no note or no key", async () => {
    const { repo, base, head, key } = await scratch();
    const missing = await run(repo, key.toString("hex"));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("no receipt note");
    // Credential checks fire per receipt shape, so a note must exist first.
    const diff = (await exec("git", ["diff", base, head], { cwd: repo })).stdout;
    const receipt = signReceipt(payloadFor(base, head, createHash("sha256").update(diff).digest("hex")), key);
    await exec("git", ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", JSON.stringify(receipt), head], { cwd: repo });
    const nokey = await run(repo, "");
    expect(nokey.code).toBe(1);
    expect(nokey.out).toContain("RIPPLEWITNESS_KEY_HEX");
  });

  it("CT-CI-02: ed25519 receipt verifies under the public key only", async () => {
    const { repo, base, head } = await scratch();
    const diff = (await exec("git", ["diff", base, head], { cwd: repo })).stdout;
    const diffHash = createHash("sha256").update(diff).digest("hex");
    const keys = loadOrCreateSignKey(mkdtempSync(join(tmpdir(), "rw-sign-")));
    const receipt = signReceiptEd(payloadFor(base, head, diffHash), keys.privateKeyPem);
    await exec("git", ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", JSON.stringify(receipt), head], { cwd: repo });
    const env = { RIPPLEWITNESS_PUBKEY_PEM: keys.publicKeyPem };
    // No HMAC key needed: the ed path ignores RIPPLEWITNESS_KEY_HEX.
    await expect(run(repo, "", env)).resolves.toEqual({ code: 0, out: "VALID tier:L3" });
    const wrong = loadOrCreateSignKey(mkdtempSync(join(tmpdir(), "rw-sign-")));
    const bad = await run(repo, "", { RIPPLEWITNESS_PUBKEY_PEM: wrong.publicKeyPem });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("signature_mismatch");
    const nopub = await run(repo, "");
    expect(nopub.code).toBe(1);
    expect(nopub.out).toContain("RIPPLEWITNESS_PUBKEY_PEM");
    // Tampered payload fails even under the right key.
    const forged = signReceiptEd(payloadFor(base, head, "0".repeat(64)), keys.privateKeyPem);
    await exec("git", ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", JSON.stringify(forged), head], { cwd: repo });
    const tampered = await run(repo, "", env);
    expect(tampered.code).toBe(1);
    expect(tampered.out).toContain("diffHash_mismatch");
  });
});
