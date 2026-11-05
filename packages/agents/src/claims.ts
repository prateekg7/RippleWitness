import { z } from "zod";
import { DEFAULT_OUTPUT_TOKENS, type MetaCallContext, type MetaClient } from "./meta.js";

export const ClaimSchema = z.object({
  type: z.enum(["SCOPE", "BEHAVIOR_UNCHANGED", "IMPLEMENTED", "TESTS", "API_COMPAT"]),
  text: z.string().min(1),
  // Optional on the wire: the live model routinely omits it. extractClaims
  // recomputes the span from the verbatim text before returning.
  sourceSpan: z.tuple([z.number(), z.number()]).optional(),
  params: z.object({
    routes: z.array(z.string()).default([]),
    symbol: z.string().optional(),
    route: z.string().optional(),
    passing: z.boolean().optional(),
    added: z.boolean().optional(),
    breaking: z.boolean().optional(),
  }),
});
export type ExtractedClaim = z.infer<typeof ClaimSchema>;
const ClaimsSchema = z.object({ claims: z.array(ClaimSchema).max(12) });

const SYSTEM = `TASK: Extract checkable claims that an author makes about a code change.
INPUT: the author's final message inside <data>...</data>; KNOWN_ROUTES; CHANGED_FILES.
RULES:
1. Output only claims the author actually asserts. Do not infer, praise, or evaluate truth.
2. One assertion per claim. Copy the sentence verbatim into "text"; give its character span [start,end] in the message.
3. Types: SCOPE (what is / is not affected), BEHAVIOR_UNCHANGED (existing behavior preserved),
   IMPLEMENTED (a feature/route/function was added or changed), TESTS (tests added or passing),
   API_COMPAT (no breaking API change).
4. params.routes may contain only ids from KNOWN_ROUTES; omit anything else.
5. If there are no checkable claims return {"claims": []}. Maximum 12 claims.`;

/** Claim Extractor (AGENTS B1). Facts flow through; code validates routes post-hoc. */
export async function extractClaims(
  client: MetaClient,
  agentMessage: string,
  knownRoutes: string[],
  changedFiles: string[] = [],
  ctx: MetaCallContext = {},
): Promise<ExtractedClaim[]> {
  const user = `KNOWN_ROUTES: ${knownRoutes.join(", ")}\nCHANGED_FILES: ${changedFiles.join(", ")}\n<data>${agentMessage}</data>`;
  const out = await client.completeJson(SYSTEM, user, ClaimsSchema, DEFAULT_OUTPUT_TOKENS, { ...ctx, agent: "claimExtractor" });
  const known = new Set(knownRoutes);
  return out.claims.map((c) => {
    const start = agentMessage.indexOf(c.text);
    return {
      ...c,
      sourceSpan: c.sourceSpan ?? (start >= 0 ? [start, start + c.text.length] as [number, number] : [0, 0] as [number, number]),
      params: { ...c.params, routes: (c.params.routes ?? []).filter((r) => known.has(r)) },
    };
  });
}
