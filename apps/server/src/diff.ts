/** Unified-diff parser for the F-01 diff cockpit. Pure. */

export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunkView {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  file: string;
  hunks: DiffHunkView[];
  truncated: boolean;
}

/** Caps so a giant diff cannot kill the review view. */
export const DIFF_MAX_FILES = 100;
export const DIFF_MAX_LINES_PER_FILE = 2000;

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunkView | null = null;
  let oldNo = 0;
  let newNo = 0;
  const pushLine = (type: DiffLine["type"], text: string): void => {
    if (!cur || !hunk || cur.truncated) return;
    const total = cur.hunks.reduce((n, h) => n + h.lines.length, 0);
    if (total >= DIFF_MAX_LINES_PER_FILE) {
      cur.truncated = true;
      return;
    }
    if (type === "context") {
      hunk.lines.push({ type, text, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else if (type === "add") {
      hunk.lines.push({ type, text, oldNo: null, newNo });
      newNo += 1;
    } else {
      hunk.lines.push({ type, text, oldNo, newNo: null });
      oldNo += 1;
    }
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      const file = raw.slice("+++ b/".length);
      if (files.length >= DIFF_MAX_FILES) {
        cur = null;
        hunk = null;
        continue;
      }
      cur = { file, hunks: [], truncated: false };
      files.push(cur);
      hunk = null;
    } else if (raw.startsWith("@@ ") && cur) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: raw, oldStart: oldNo, newStart: newNo, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk && cur && !raw.startsWith("diff --git") && !raw.startsWith("index ") && !raw.startsWith("--- ") && !raw.startsWith("+++ ")) {
      if (raw.startsWith("+")) pushLine("add", raw.slice(1));
      else if (raw.startsWith("-")) pushLine("del", raw.slice(1));
      else if (raw.startsWith(" ")) pushLine("context", raw.slice(1));
      else if (raw === "\\ No newline at end of file") continue;
      else if (raw.length === 0) continue;
      else pushLine("context", raw);
    }
  }
  return files.filter((f) => f.hunks.length > 0);
}
