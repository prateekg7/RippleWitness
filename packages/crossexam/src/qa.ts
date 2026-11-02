import type { ClaimVerdict } from "@ripplewitness/core";

export type QuestionStatus = "OPEN" | "ASKED" | "RESOLVED" | "CONTESTED";

export const MAX_ASKED_PER_REVIEW = 5;
export const MAX_ASKS_PER_QUESTION = 3; // initial + 2 follow-ups

export interface AnswerAssessment {
  status: QuestionStatus;
  followup: string | null;
}

/**
 * TRD §7.9 resolution (D-05). Pure state machine over the ANSWER's claim
 * verdicts (computed by verifiers in code, never by the LLM):
 * - every answer claim SUPPORTED and the anchor explained -> RESOLVED
 * - any answer claim CONTRADICTED -> CONTESTED
 * - otherwise OPEN with a follow-up (while asks remain), else ASKED.
 */
export function assessAnswer(
  answerVerdicts: ClaimVerdict[],
  explainsAnchor: boolean,
  asksUsed: number,
  anchor: string,
): AnswerAssessment {
  if (answerVerdicts.length > 0 && answerVerdicts.every((v) => v === "SUPPORTED") && explainsAnchor) {
    return { status: "RESOLVED", followup: null };
  }
  if (answerVerdicts.includes("CONTRADICTED")) {
    return { status: "CONTESTED", followup: null };
  }
  if (asksUsed < MAX_ASKS_PER_QUESTION) {
    return {
      status: "OPEN",
      followup: `Follow-up (${asksUsed + 1}/${MAX_ASKS_PER_QUESTION}): the previous answer did not verify against replay. ${anchor} Answer concisely; if you did not verify something, say "not verified".`,
    };
  }
  return { status: "ASKED", followup: null };
}

export function quotaAllows(askedCount: number): boolean {
  return askedCount < MAX_ASKED_PER_REVIEW;
}
