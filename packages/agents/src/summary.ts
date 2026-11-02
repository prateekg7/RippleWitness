import { z } from "zod";
import type { MetaClient } from "./meta.js";

export const SummarySchema = z.object({
  title: z.string().min(1).max(72),
  body: z.string().min(1),
  observed_impact: z.array(z.string()),
  unverified: z.array(z.string()),
});
export type PrSummary = z.infer<typeof SummarySchema>;

const SYSTEM = `TASK: Write a PR title (at most 72 chars) and body from the diff and replay observations in <data>.
Never repeat the agent's own description. Explicitly list routes that were not exercised under "unverified".`;

export interface SummaryInput {
  diff: string;
  observations: { routeId: string; changed: boolean }[];
  exercised: string[];
  unexercisedImpacted: string[];
}

/** Validator: impact ⊆ exercised, unverified ⊇ all unexercised-impacted. Pure. */
export function validateSummary(out: PrSummary, input: SummaryInput): { ok: true } | { ok: false; reason: string } {
  const exercised = new Set(input.exercised);
  for (const r of out.observed_impact) {
    if (!exercised.has(r)) return { ok: false, reason: `impact not exercised: ${r}` };
  }
  const unverified = new Set(out.unverified);
  for (const r of input.unexercisedImpacted) {
    if (!unverified.has(r)) return { ok: false, reason: `missing unverified route: ${r}` };
  }
  return { ok: true };
}

/**
 * Prompt-fit budget: the summary shares the prompt with the full observations
 * array, so the diff gets a smaller slice (~2,000 tokens) than the reviewer.
 */
export const SUMMARY_DIFF_CHAR_LIMIT = 8000;

export async function runSummary(client: MetaClient, input: SummaryInput): Promise<PrSummary> {
  const user = `<data>${JSON.stringify({ diff: input.diff.slice(0, SUMMARY_DIFF_CHAR_LIMIT), observations: input.observations })}</data>`;
  const out = await client.completeJson(SYSTEM, user, SummarySchema);
  const v = validateSummary(out, input);
  if (!v.ok) throw new Error(`summary failed validation: ${v.reason}`);
  return out;
}
