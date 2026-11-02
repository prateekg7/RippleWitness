import { z } from "zod";
import type { MetaClient } from "./meta.js";

export const FindingSchema = z.object({
  file: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  severity: z.enum(["low", "medium", "high"]),
  category: z.enum(["bug", "security", "quality"]),
  note: z.string().min(1).max(500),
});
export type AiFinding = z.infer<typeof FindingSchema>;
const FindingsSchema = z.object({ findings: z.array(FindingSchema).max(15) });

const SYSTEM = `TASK: Identify likely bugs, security problems, or significant quality issues in the diff. No style nits. Maximum 15 findings.
Each finding must cite a file and a line range that exists in the diff. Be specific and brief.`;

/**
 * Prompt-fit budget: the reviewer sees the whole diff at once, so it gets the
 * largest per-agent slice (~3,000 tokens) of the 4,000-input-token cap.
 */
export const DIFF_CHAR_LIMIT = 12000;

export interface DiffHunk {
  file: string;
  newStart: number;
  newEnd: number;
}

/** Parse unified diff hunks (new-tree ranges) per file. Pure. */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
    } else if (line.startsWith("@@ ") && file) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const len = m[2] === undefined ? 1 : Number(m[2]);
        hunks.push({ file, newStart: start, newEnd: start + Math.max(len, 1) - 1 });
      }
    }
  }
  return hunks;
}

/** Every finding must cite a line range inside the diff; extras are rejected. Pure. */
export function validateFindings(
  findings: AiFinding[],
  hunks: DiffHunk[],
): { valid: AiFinding[]; rejected: { finding: AiFinding; reason: string }[] } {
  const valid: AiFinding[] = [];
  const rejected: { finding: AiFinding; reason: string }[] = [];
  for (const f of findings.slice(0, 15)) {
    if (f.startLine > f.endLine) {
      rejected.push({ finding: f, reason: "inverted range" });
      continue;
    }
    const hit = hunks.some((h) => h.file === f.file && f.startLine <= h.newEnd && f.endLine >= h.newStart);
    if (!hit) {
      rejected.push({ finding: f, reason: "range not in diff" });
      continue;
    }
    valid.push(f);
  }
  for (const f of findings.slice(15)) rejected.push({ finding: f, reason: "over 15-findings cap" });
  return { valid, rejected };
}

/** AI Reviewer (AGENTS B5). Blind-first gating is enforced by the server. */
export async function runReviewer(client: MetaClient, diff: string): Promise<AiFinding[]> {
  const out = await client.completeJson(SYSTEM, `<data>${diff.slice(0, DIFF_CHAR_LIMIT)}</data>`, FindingsSchema);
  return out.findings;
}
