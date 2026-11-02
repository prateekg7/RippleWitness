export const PACKAGE_NAME = "@ripplewitness/receipt" as const;
export { keyPath, loadOrCreateKey } from "./key.js";
export type { ReceiptPayload, SignedReceipt, VerifyOutcome } from "./receipt.js";
export { ReceiptPayloadSchema, signReceipt, trailerValue, verifyReceipt } from "./receipt.js";
export { NOTES_REF, readNote, writeNote } from "./gitnotes.js";
