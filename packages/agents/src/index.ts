export const PACKAGE_NAME = "@ripplewitness/agents" as const;
export type { AgentAnswer, AgentMode, AgentSessionPort, ExecOptions, TranscriptTurn } from "./session.js";
export { ExecSession, MockSession, findLatestSessionJsonl, loadTranscript, parseExecJsonl } from "./session.js";
export { redactSecrets } from "./redactor.js";
export {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_OUTPUT_TOKENS,
  INJECTION_GUARD,
  MetaClient,
  MetaDegraded,
  USER_CONTENT_CHAR_LIMIT,
} from "./meta.js";
export type { MetaOptions } from "./meta.js";
export type { ExtractedClaim } from "./claims.js";
export { ClaimSchema, extractClaims } from "./claims.js";
export type { AiFinding, DiffHunk } from "./reviewer.js";
export { DIFF_CHAR_LIMIT, FindingSchema, parseDiffHunks, runReviewer, validateFindings } from "./reviewer.js";
export type { ExplainerInput, Explanation } from "./explainer.js";
export { ExplanationSchema, HUNK_CHAR_LIMIT, runExplainer, validateExplanation } from "./explainer.js";
export type { PrSummary, SummaryInput } from "./summary.js";
export { SUMMARY_DIFF_CHAR_LIMIT, SummarySchema, runSummary, validateSummary } from "./summary.js";
