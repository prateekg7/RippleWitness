import type { FusedNode, Miss } from "@ripplewitness/core";
import type { VerifyResult } from "./verifiers.js";

export type QuestionTemplate = "SURPRISE_RIPPLE" | "SCOPE_CREEP" | "CONTRADICTION" | "MISSED_PREDICTION";

export interface BuiltQuestion {
  template: QuestionTemplate;
  routeId: string | null;
  claimId: string | null;
  /** Raw template with [[protected tokens]]; LLM may only rephrase. */
  text: string;
  anchors: string[];
  need: number;
}

export interface QuestionInput {
  fused: FusedNode[];
  claimResults: { claimId: string; verdict: string; routes: string[] }[];
  misses?: Miss[];
  routeDiffSummary?: Map<string, string>;
}

const NEED: Record<QuestionTemplate, number> = {
  SURPRISE_RIPPLE: 3,
  CONTRADICTION: 3,
  MISSED_PREDICTION: 2,
  SCOPE_CREEP: 1,
};

function diffSummary(input: QuestionInput, routeId: string): string {
  return input.routeDiffSummary?.get(routeId) ?? "response differs between base and head";
}

/** TRD §7.8: deterministic question templates from fused evidence. Pure. */
export function buildQuestions(input: QuestionInput): BuiltQuestion[] {
  const out: BuiltQuestion[] = [];
  for (const n of input.fused) {
    if (n.status === "SURPRISE" && n.routeId) {
      out.push({
        template: "SURPRISE_RIPPLE",
        routeId: n.routeId,
        claimId: null,
        text: `[[${n.routeId}]] changed at runtime but no static path links it to this diff. What coupling explains it?`,
        anchors: [`response diff for ${n.routeId}: ${diffSummary(input, n.routeId)}`, "static impact: no path found"],
        need: NEED.SURPRISE_RIPPLE,
      });
    }
    if (n.status === "UNVERIFIED" && n.routeId) {
      out.push({
        template: "SCOPE_CREEP",
        routeId: n.routeId,
        claimId: null,
        text: `[[${n.routeId}]] is statically impacted but no scenario exercises it. How was it verified?`,
        anchors: ["coverage: UNVERIFIED (no scenario)"],
        need: NEED.SCOPE_CREEP,
      });
    }
  }
  for (const c of input.claimResults) {
    if (c.verdict !== "CONTRADICTED") continue;
    out.push({
      template: "CONTRADICTION",
      routeId: c.routes[0] ?? null,
      claimId: c.claimId,
      text: `Claim [[${c.claimId}]] is contradicted by replay evidence. Which part of the claim is wrong?`,
      anchors: [`claim verdict: CONTRADICTED`, `scope: ${c.routes.join(", ") || "none"}`],
      need: NEED.CONTRADICTION,
    });
  }
  for (const m of input.misses ?? []) {
    out.push({
      template: "MISSED_PREDICTION",
      routeId: m.routeId,
      claimId: null,
      text: `You did not predict [[${m.routeId}]] (miss cause: [[${m.cause}]]). What would have revealed it?`,
      anchors: [`miss cause: ${m.cause}`],
      need: NEED.MISSED_PREDICTION,
    });
  }
  return out
    .sort((a, b) => b.need - a.need || (a.routeId ?? "").localeCompare(b.routeId ?? ""))
    .slice(0, 5);
}

/** Cap-aware pick: at most 5 asked per review, follow-ups preferred by need. */
export function pickNext(questions: { need: number; status: string }[]): number {
  let best = -1;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as { need: number; status: string };
    if (q.status !== "OPEN") continue;
    if (best === -1 || q.need > (questions[best] as { need: number }).need) best = i;
  }
  return best;
}

/** Phraser validator (AGENTS B2): every [[token]] must survive rephrasing. */
export function validatePhrased(raw: string, phrased: string): boolean {
  const tokens = [...raw.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1] as string);
  return tokens.every((t) => phrased.includes(t));
}

export function rephrasePassthrough(raw: string): string {
  return raw.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

export type { VerifyResult };
