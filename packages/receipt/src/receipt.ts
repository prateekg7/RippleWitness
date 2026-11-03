import { createHash, createHmac, sign, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";

export const ReceiptPayloadSchema = z.object({
  runId: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  diffHash: z.string(),
  scenarioHash: z.string(),
  prediction: z.unknown(),
  score: z.object({ recall: z.number(), precision: z.number(), passed: z.boolean(), passReason: z.string() }),
  overrideReason: z.string().nullable(),
  claims: z.array(z.object({ claimId: z.string(), verdict: z.string() })),
  questions: z.array(z.object({ id: z.string(), status: z.string() })),
  agentMode: z.string(),
  createdAt: z.string(),
  /** Assurance tier (F-25). Optional so pre-K-06 receipts still verify. */
  assuranceTier: z.enum(["L0", "L1", "L2", "L3"]).optional(),
  /** Content hashes of declared model/dataset artifacts (F-25). */
  artifactHashes: z.record(z.string()).optional(),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayloadSchema>;

export interface SignedReceipt {
  payload: ReceiptPayload;
  hmac: string;
}

function canonical(payload: ReceiptPayload): string {
  return JSON.stringify(payload);
}

export function signReceipt(payload: ReceiptPayload, key: Buffer): SignedReceipt {
  return { payload, hmac: createHmac("sha256", key).update(canonical(payload), "utf8").digest("hex") };
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

export function verifyReceipt(receipt: unknown, key: Buffer): VerifyOutcome {
  const parsed = z.object({ payload: ReceiptPayloadSchema, hmac: z.string() }).safeParse(receipt);
  if (!parsed.success) return { ok: false, reason: "malformed_receipt" };
  const expected = createHmac("sha256", key).update(canonical(parsed.data.payload), "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parsed.data.hmac, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "hmac_mismatch" };
  return { ok: true };
}

export function trailerValue(receipt: SignedReceipt | SignedEdReceipt): string {
  const tag = "hmac" in receipt ? receipt.hmac.slice(0, 16) : `ed25519:${receipt.signature.slice(0, 16)}`;
  return `RippleWitness-Receipt: ${tag}:${createHash("sha256").update(canonical(receipt.payload)).digest("hex").slice(0, 12)}`;
}

/** ed25519-signed receipt (M-08). The public key is NOT embedded: verifiers must supply the trust anchor. */
export const EdReceiptSchema = z.object({
  payload: ReceiptPayloadSchema,
  alg: z.literal("ed25519"),
  signature: z.string(),
});
export type SignedEdReceipt = z.infer<typeof EdReceiptSchema>;

export function signReceiptEd(payload: ReceiptPayload, privateKeyPem: string): SignedEdReceipt {
  return {
    payload,
    alg: "ed25519",
    signature: sign(null, Buffer.from(canonical(payload), "utf8"), privateKeyPem).toString("hex"),
  };
}

export function verifyReceiptEd(receipt: unknown, publicKeyPem: string): VerifyOutcome {
  const parsed = EdReceiptSchema.safeParse(receipt);
  if (!parsed.success) return { ok: false, reason: "malformed_receipt" };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonical(parsed.data.payload), "utf8"), publicKeyPem, Buffer.from(parsed.data.signature, "hex"));
  } catch {
    return { ok: false, reason: "malformed_receipt" };
  }
  if (!ok) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

/** Dispatch on receipt shape: `hmac` → shared-key path, `alg: ed25519` → public-key path. */
export function verifyReceiptAny(
  receipt: unknown,
  keys: { hmacKey?: Buffer; publicKeyPem?: string },
): VerifyOutcome {
  if (typeof receipt === "object" && receipt !== null && (receipt as { alg?: unknown }).alg === "ed25519") {
    if (!keys.publicKeyPem) return { ok: false, reason: "public_key_required" };
    return verifyReceiptEd(receipt, keys.publicKeyPem);
  }
  if (!keys.hmacKey) return { ok: false, reason: "hmac_key_required" };
  return verifyReceipt(receipt, keys.hmacKey);
}
