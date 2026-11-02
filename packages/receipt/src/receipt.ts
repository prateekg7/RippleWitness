import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

export function trailerValue(receipt: SignedReceipt): string {
  return `RippleWitness-Receipt: ${receipt.hmac.slice(0, 16)}:${createHash("sha256").update(canonical(receipt.payload)).digest("hex").slice(0, 12)}`;
}
