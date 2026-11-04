import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { keyPath, loadOrCreateKey, loadOrCreateSignKey } from "./key.js";
import { readNote, signReceipt, signReceiptEd, trailerValue, verifyReceipt, verifyReceiptAny, verifyReceiptEd, writeNote } from "./index.js";
import type { ReceiptPayload } from "./index.js";

const execFileP = promisify(execFile);

function payload(): ReceiptPayload {
  return {
    runId: "r1",
    baseRef: "b",
    headRef: "h",
    diffHash: "d",
    scenarioHash: "s",
    prediction: { routeIds: [] },
    score: { recall: 1, precision: 1, passed: true, passReason: "thresholds_met" },
    overrideReason: null,
    claims: [],
    questions: [],
    agentMode: "live_session",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("receipt (E-03)", () => {
  it("CT-RC-01: sign/verify roundtrip", () => {
    const key = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const r = signReceipt(payload(), key);
    expect(verifyReceipt(r, key)).toEqual({ ok: true });
    expect(trailerValue(r)).toMatch(/^RippleWitness-Receipt: [0-9a-f]{16}:[0-9a-f]{12}$/);
  });
  it("CT-RC-02: tampered payload fails", () => {
    const key = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const r = signReceipt(payload(), key);
    const tampered = { ...r, payload: { ...r.payload, headRef: "evil" } };
    expect(verifyReceipt(tampered, key)).toEqual({ ok: false, reason: "hmac_mismatch" });
  });
  it("CT-RC-03: wrong key fails; malformed fails", () => {
    const k1 = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const k2 = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const r = signReceipt(payload(), k1);
    expect(verifyReceipt(r, k2)).toEqual({ ok: false, reason: "hmac_mismatch" });
    expect(verifyReceipt({ nope: 1 }, k1)).toEqual({ ok: false, reason: "malformed_receipt" });
  });
  it("CT-RC-04: git note roundtrip on a scratch repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-note-"));
    await execFileP("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    await execFileP("git", ["config", "user.email", "t@l"], { cwd: dir });
    await execFileP("git", ["config", "user.name", "t"], { cwd: dir });
    await execFileP("git", ["commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
    const key = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const r = signReceipt(payload(), key);
    expect(await readNote(dir, "HEAD")).toBeNull();
    await writeNote(dir, "HEAD", JSON.stringify(r));
    const back = await readNote(dir, "HEAD");
    expect(back).not.toBeNull();
    expect(verifyReceipt(JSON.parse(back as string), key)).toEqual({ ok: true });
  });
  it("CT-RC-04b: git note roundtrip with no configured git identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-note-noident-"));
    await execFileP("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    // Initial commit carries its identity per-invocation; nothing is stored
    // in repo or global config for writeNote to lean on.
    await execFileP("git", ["-c", "user.email=t@l", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
    const key = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const r = signReceipt(payload(), key);
    const prev = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.HOME = mkdtempSync(join(tmpdir(), "rw-empty-home-"));
    process.env.XDG_CONFIG_HOME = process.env.HOME;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      await writeNote(dir, "HEAD", JSON.stringify(r));
      const back = await readNote(dir, "HEAD");
      expect(back).not.toBeNull();
      expect(verifyReceipt(JSON.parse(back as string), key)).toEqual({ ok: true });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it("key file is created, not logged", () => {
    const home = mkdtempSync(join(tmpdir(), "rw-key-"));
    const k1 = loadOrCreateKey(home);
    const k2 = loadOrCreateKey(home);
    expect(k1.equals(k2)).toBe(true);
    expect(keyPath(home)).toContain("key");
  });
  it("CT-RC-05: tier + artifact hashes roundtrip; legacy payloads still verify", () => {
    const key = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const tiered = signReceipt({ ...payload(), assuranceTier: "L3", artifactHashes: { "model.json": "sha256:abc" } }, key);
    expect(verifyReceipt(tiered, key)).toEqual({ ok: true });
    expect(tiered.payload.assuranceTier).toBe("L3");
    const legacy = signReceipt(payload(), key);
    expect(verifyReceipt(legacy, key)).toEqual({ ok: true });
    expect(legacy.payload.assuranceTier).toBeUndefined();
  });
  it("CT-RC-06: ed25519 sign/verify roundtrip; tamper and wrong key fail", () => {
    const keys = loadOrCreateSignKey(mkdtempSync(join(tmpdir(), "rw-sign-")));
    const again = loadOrCreateSignKey(mkdtempSync(join(tmpdir(), "rw-sign-")));
    const r = signReceiptEd(payload(), keys.privateKeyPem);
    expect(r.alg).toBe("ed25519");
    expect(verifyReceiptEd(r, keys.publicKeyPem)).toEqual({ ok: true });
    expect(trailerValue(r)).toMatch(/^RippleWitness-Receipt: ed25519:[0-9a-f]{16}:[0-9a-f]{12}$/);
    const tampered = { ...r, payload: { ...r.payload, headRef: "evil" } };
    expect(verifyReceiptEd(tampered, keys.publicKeyPem)).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyReceiptEd(r, again.publicKeyPem)).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyReceiptEd({ nope: 1 }, keys.publicKeyPem)).toEqual({ ok: false, reason: "malformed_receipt" });
  });
  it("CT-RC-07: verifyReceiptAny dispatches on shape and names the missing credential", () => {
    const hmacKey = loadOrCreateKey(mkdtempSync(join(tmpdir(), "rw-key-")));
    const keys = loadOrCreateSignKey(mkdtempSync(join(tmpdir(), "rw-sign-")));
    const h = signReceipt(payload(), hmacKey);
    const e = signReceiptEd(payload(), keys.privateKeyPem);
    expect(verifyReceiptAny(h, { hmacKey })).toEqual({ ok: true });
    expect(verifyReceiptAny(e, { publicKeyPem: keys.publicKeyPem })).toEqual({ ok: true });
    expect(verifyReceiptAny(e, { hmacKey })).toEqual({ ok: false, reason: "public_key_required" });
    expect(verifyReceiptAny(h, { publicKeyPem: keys.publicKeyPem })).toEqual({ ok: false, reason: "hmac_key_required" });
    // Cross-shape replay: an HMAC receipt never verifies as ed25519 and vice versa.
    expect(verifyReceiptEd(h, keys.publicKeyPem)).toEqual({ ok: false, reason: "malformed_receipt" });
    expect(verifyReceipt(e, hmacKey)).toEqual({ ok: false, reason: "malformed_receipt" });
  });
});
