import { z } from "zod";
import { DEFAULT_OUTPUT_TOKENS, type MetaCallContext, type MetaClient } from "./meta.js";

export const ExplanationSchema = z.object({
  summary: z.string().min(1),
  what_changed: z.array(z.string()),
  who_is_affected: z.array(z.string()),
  risks: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

const SYSTEM = `TASK: Explain what this change does, for a reviewer, in at most {maxSentences} sentences.
Use ONLY the hunk, graph neighbors, and observations inside <data>. If a statement is not supported by them, omit it.
List affected route ids only if they appear in the input. Set confidence low if evidence is thin.`;

export interface ExplainerInput {
  routeId: string;
  hunk: string;
  neighbors: string[];
  observations: string[];
  knownRoutes: string[];
  maxSentences?: number;
}

/**
 * Prompt-fit budget: the explainer prompt is mostly neighbors + observations,
 * so the hunk itself is capped small (~1,000 tokens).
 */
export const HUNK_CHAR_LIMIT = 4000;

function sentenceCount(s: string): number {
  return s.split(/[.!?]+/).filter((x) => x.trim().length > 0).length;
}

/** Traceability validator: routes ⊆ input, summary bounded. Pure. */
export function validateExplanation(out: Explanation, input: ExplainerInput): { ok: true } | { ok: false; reason: string } {
  const known = new Set(input.knownRoutes);
  for (const r of out.who_is_affected) {
    if (!known.has(r)) return { ok: false, reason: `route not in evidence: ${r}` };
  }
  const max = input.maxSentences ?? 5;
  if (sentenceCount(out.summary) > max) return { ok: false, reason: `summary exceeds ${max} sentences` };
  return { ok: true };
}

export async function runExplainer(client: MetaClient, input: ExplainerInput, ctx: MetaCallContext = {}): Promise<Explanation> {
  const system = SYSTEM.replace("{maxSentences}", String(input.maxSentences ?? 5));
  const user = `<data>${JSON.stringify({ route: input.routeId, hunk: input.hunk.slice(0, HUNK_CHAR_LIMIT), neighbors: input.neighbors, observations: input.observations })}</data>`;
  const out = await client.completeJson(system, user, ExplanationSchema, DEFAULT_OUTPUT_TOKENS, { ...ctx, agent: "explainer" });
  const v = validateExplanation(out, input);
  if (!v.ok) throw new Error(`explanation failed traceability: ${v.reason}`);
  return out;
}
