import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";

const DIFF = `diff --git a/f.ts b/f.ts
index 111..222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,4 @@
 line1
-old
+new
+added
 line3
diff --git a/g.ts b/g.ts
index 333..444 100644
--- a/g.ts
+++ b/g.ts
@@ -10,2 +10,2 @@
 keep
-was
+is
`;

describe("diff parser F-01 (CT-F01-01)", () => {
  it("parses files, hunks, and line numbers", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => f.file)).toEqual(["f.ts", "g.ts"]);
    const h = files[0]?.hunks[0];
    expect(h?.oldStart).toBe(1);
    expect(h?.newStart).toBe(1);
    expect(h?.lines.map((l) => [l.type, l.text, l.oldNo, l.newNo])).toEqual([
      ["context", "line1", 1, 1],
      ["del", "old", 2, null],
      ["add", "new", null, 2],
      ["add", "added", null, 3],
      ["context", "line3", 3, 4],
    ]);
  });

  it("returns [] for empty diffs and skips file cap overflow", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    const one = `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(parseUnifiedDiff(one)).toHaveLength(1);
  });

  it("truncates giant files instead of dropping them", () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `+l${i}`).join("\n");
    const files = parseUnifiedDiff(`+++ b/big.ts\n@@ -1 +1 @@\n${lines}\n`);
    expect(files[0]?.truncated).toBe(true);
    expect(files[0]?.hunks[0]?.lines.length).toBe(2000);
  });
});
