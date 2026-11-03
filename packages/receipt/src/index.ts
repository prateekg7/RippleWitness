export const PACKAGE_NAME = "@ripplewitness/receipt" as const;
export { keyPath, loadOrCreateKey, loadOrCreateSignKey, signKeyPath, signPubPath } from "./key.js";
export type { ReceiptPayload, SignedEdReceipt, SignedReceipt, VerifyOutcome } from "./receipt.js";
export {
  EdReceiptSchema,
  ReceiptPayloadSchema,
  signReceipt,
  signReceiptEd,
  trailerValue,
  verifyReceipt,
  verifyReceiptAny,
  verifyReceiptEd,
} from "./receipt.js";
export { NOTES_REF, readNote, writeNote } from "./gitnotes.js";
