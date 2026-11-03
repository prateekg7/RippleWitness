import { z } from "zod";
import { rephrasePassthrough, validatePhrased } from "@ripplewitness/crossexam";
import { DEFAULT_OUTPUT_TOKENS, type MetaCallContext, type MetaClient } from "./meta.js";

export type PhraserTone = "direct" | "neutral" | "socratic";

const PhrasedSchema = z.object({ text: z.string().min(1).max(2000) });

function systemFor(tone: PhraserTone): string {
  return `TASK: Rephrase the review question for clarity and a neutral tone (style: ${tone}).
Every token wrapped in [[double brackets]] (ids, paths, numbers) must appear unchanged in the output without the brackets.
Do not add facts, causes, or advice. Output {"text":"…"} only.`;
}

/**
 * Question Phraser (AGENTS B2). Facts are fixed by code; the LLM may only
 * rephrase. Any failure — transport, schema, or a dropped protected token —
 * falls back to the raw template with brackets stripped. Never throws.
 */
export async function phraseQuestion(
  client: MetaClient,
  raw: string,
  opts: { tone?: PhraserTone; ctx?: MetaCallContext } = {},
): Promise<{ text: string; usedLlm: boolean }> {
  const fallback = rephrasePassthrough(raw);
  if (!/\[\[.+\]\]/.test(raw)) return { text: fallback, usedLlm: false };
  try {
    const out = await client.completeJson(systemFor(opts.tone ?? "neutral"), `<data>${raw}</data>`, PhrasedSchema, DEFAULT_OUTPUT_TOKENS, {
      ...(opts.ctx ?? {}),
      agent: "questionPhraser",
    });
    if (!validatePhrased(raw, out.text)) return { text: fallback, usedLlm: false };
    return { text: out.text, usedLlm: true };
  } catch {
    return { text: fallback, usedLlm: false };
  }
}
