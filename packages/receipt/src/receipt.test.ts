import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { keyPath, loadOrCreateKey } from "./key.js";
import { readNote, signReceipt, trailerValue, verifyReceipt, writeNote } from "./index.js";
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
  it("key file is created, not logged", () => {
    const home = mkdtempSync(join(tmpdir(), "rw-key-"));
    const k1 = loadOrCreateKey(home);
    const k2 = loadOrCreateKey(home);
    expect(k1.equals(k2)).toBe(true);
    expect(keyPath(home)).toContain("key");
  });
});
