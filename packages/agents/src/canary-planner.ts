import { z } from "zod";
import type { CanaryOperator } from "@ripplewitness/canary";
import { DEFAULT_OUTPUT_TOKENS, type MetaCallContext, type MetaClient } from "./meta.js";

const SYSTEM = `TASK: From the changed hunks in <data>, choose ONE hunk in a function reachable from a route and propose a subtle,
plausible defect using one operator: flip_cmp, off_by_one, swap_args, drop_guard, const_step, negate_cond.
Never propose syntax errors or changes that cannot alter behavior. OUTPUT: {"file":"","line":0,"operator":"","rationale":""}`;

const OPERATORS = ["flip_cmp", "off_by_one", "swap_args", "drop_guard", "const_step", "negate_cond"] as const satisfies readonly CanaryOperator[];

export const PlanSchema = z.object({
  file: z.string().min(1).max(500),
  line: z.number().int().positive(),
  operator: z.enum(OPERATORS),
  rationale: z.string().min(1).max(500),
});
export type CanaryPlan = z.infer<typeof PlanSchema>;

export interface PlanHunk {
  file: string;
  startLine: number;
  text: string;
}

/**
 * Canary Planner (AGENTS B6). Proposes file+operator; code selects the exact
 * site and execution validation decides acceptance. Returns null on any
 * failure so the caller falls back to the deterministic proposer. Never throws.
 */
export async function planCanary(
  client: MetaClient,
  hunks: PlanHunk[],
  ctx: MetaCallContext = {},
): Promise<CanaryPlan | null> {
  if (hunks.length === 0) return null;
  const data = hunks
    .slice(0, 20)
    .map((h) => `--- ${h.file}:${h.startLine}\n${h.text.slice(0, 1500)}`)
    .join("\n");
  try {
    const out = await client.completeJson(SYSTEM, `<data>${data}</data>`, PlanSchema, DEFAULT_OUTPUT_TOKENS, { ...ctx, agent: "canaryPlanner" });
    if (out.file.split("/").includes("..")) return null;
    return out;
  } catch {
    return null;
  }
}
