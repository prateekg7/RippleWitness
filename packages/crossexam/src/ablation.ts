/** F-16 Causal Ablation: pure planning + text edits. Execution lives server-side. */

export type AblationKind = "pin_file" | "drop_event";

export interface AblationCandidate {
  kind: AblationKind;
  /** Repo-relative file the ablation touches. */
  file: string;
  /** Event name for drop_event. */
  event?: string;
  /** Why this ablation is a candidate for the route. */
  reason: string;
}

export type AblationVerdict = "CAUSALLY-CONFIRMED" | "CONTESTED" | "NO-ABLATION" | "ABLATION-INVALID";

/**
 * Decide the verdict from the replay comparison. Pure: the diff disappearing
 * under neutralization confirms the explanation; persistence contests it.
 */
export function verdictAblation(originalChanged: boolean, ablatedChanged: boolean | null): AblationVerdict {
  if (!originalChanged) return "NO-ABLATION";
  if (ablatedChanged === null) return "ABLATION-INVALID";
  return ablatedChanged ? "CONTESTED" : "CAUSALLY-CONFIRMED";
}

const SUB_RE = /\.\s*on\s*\(\s*["']([^"']+)["']/g;

/** Subscription event names registered in a source file. Pure. */
export function findSubscriptions(text: string): { event: string; line: number }[] {
  const out: { event: string; line: number }[] = [];
  SUB_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUB_RE.exec(text)) !== null) {
    const line = text.slice(0, m.index).split("\n").length;
    out.push({ event: m[1] as string, line });
  }
  return out;
}

/**
 * Neutralize one subscription by renaming the subscribed event to a
 * never-emitted sentinel. Single textual change, zero syntax risk:
 * the handler stays, it just never fires.
 */
export function dropEvent(text: string, event: string): { ok: true; text: string } | { ok: false; error: string } {
  if (event.includes("..") || event.includes("\"") || event.includes("'") || event.length === 0 || event.length > 200) {
    return { ok: false, error: "bad event name" };
  }
  const re = new RegExp(`(\\.\\s*on\\s*\\(\\s*["'])${escapeRe(event)}(["'])`);
  if (!re.test(text)) return { ok: false, error: `no subscription to ${event}` };
  return { ok: true, text: text.replace(re, `$1rw.ablated.${event}$2`) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Plan candidates for a route: pin every changed file on its static path,
 * and offer drop_event for every subscription found in changed files.
 * `pathFiles` maps node ids on the impact path to their source files.
 */
export function planAblations(
  changedFiles: string[],
  pathFiles: string[],
  subscriptions: { file: string; event: string }[],
): AblationCandidate[] {
  const changed = new Set(changedFiles);
  const onPath = new Set(pathFiles);
  const out: AblationCandidate[] = [];
  for (const f of changedFiles) {
    if (!onPath.has(f)) continue;
    out.push({ kind: "pin_file", file: f, reason: "changed file on the static impact path" });
  }
  for (const s of subscriptions) {
    if (!changed.has(s.file)) continue;
    out.push({ kind: "drop_event", file: s.file, event: s.event, reason: `subscription in changed file ${s.file}` });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.kind < b.kind ? -1 : 1));
}
