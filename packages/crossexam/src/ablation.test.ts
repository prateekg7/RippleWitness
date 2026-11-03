import { describe, expect, it } from "vitest";
import { dropEvent, findSubscriptions, planAblations, verdictAblation } from "./ablation.js";

describe("ablation planning F-16 (CT-ABL-01)", () => {
  it("finds .on( subscriptions across spellings", () => {
    const text = `bus.on("order.completed", h)\nbus .on( 'discount.applied' , h)\nbus.emit("order.completed", {})\n`;
    expect(findSubscriptions(text)).toEqual([
      { event: "order.completed", line: 1 },
      { event: "discount.applied", line: 2 },
    ]);
  });

  it("dropEvent renames exactly the named subscription", () => {
    const text = `bus.on("a", h1);\nbus.on("ab", h2);\n`;
    const r = dropEvent(text, "a");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain(`bus.on("rw.ablated.a", h1)`);
      expect(r.text).toContain(`bus.on("ab", h2)`);
    }
    expect(dropEvent(text, "zzz")).toEqual({ ok: false, error: "no subscription to zzz" });
    expect(dropEvent(text, `a")`).ok).toBe(false);
  });

  it("verdictAblation maps replay comparison to verdicts", () => {
    expect(verdictAblation(true, false)).toBe("CAUSALLY-CONFIRMED");
    expect(verdictAblation(true, true)).toBe("CONTESTED");
    expect(verdictAblation(true, null)).toBe("ABLATION-INVALID");
    expect(verdictAblation(false, false)).toBe("NO-ABLATION");
  });

  it("planAblations pins only changed files on the path", () => {
    const cands = planAblations(
      ["helper.js", "note.txt"],
      ["helper.js"],
      [{ file: "helper.js", event: "order.completed" }],
    );
    expect(cands).toEqual([
      { kind: "drop_event", file: "helper.js", event: "order.completed", reason: "subscription in changed file helper.js" },
      { kind: "pin_file", file: "helper.js", reason: "changed file on the static impact path" },
    ]);
  });
});
