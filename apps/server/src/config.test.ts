import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";

describe("reviewer config F-14 (CT-CFG-01)", () => {
  it("defaults when no file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "rw-cfg-"));
    const empty = mkdtempSync(join(tmpdir(), "rw-cfg-cwd-"));
    expect(loadConfig(home, empty)).toEqual({ ok: true, config: DEFAULT_CONFIG, path: null });
  });

  it("loads a full file from home, preferring home over cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "rw-cfg-"));
    const cwd = mkdtempSync(join(tmpdir(), "rw-cfg-cwd-"));
    writeFileSync(
      join(home, "ripplewitness.config.yaml"),
      "gate:\n  minRecall: 0.9\n  minPrecision: 0.8\nagents:\n  questionPhraser:\n    tone: socratic\n  explainer:\n    maxSentences: 3\n  summary:\n    style: conventional commits\n",
    );
    writeFileSync(join(cwd, "ripplewitness.config.yaml"), "gate:\n  minRecall: 0.1\n  minPrecision: 0.1\n");
    const r = loadConfig(home, cwd);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(join(home, "ripplewitness.config.yaml"));
      expect(r.config).toEqual({
        gate: { minRecall: 0.9, minPrecision: 0.8 },
        tone: "socratic",
        explainerMaxSentences: 3,
        summaryStyle: "conventional commits",
      });
    }
  });

  it("fills partial files with defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "rw-cfg-"));
    writeFileSync(join(home, "ripplewitness.config.yaml"), "agents:\n  summary:\n    style: terse\n");
    const r = loadConfig(home, home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toEqual({ ...DEFAULT_CONFIG, summaryStyle: "terse" });
  });

  it("fails fast on bad YAML, bad values, and unknown keys", () => {
    const home = mkdtempSync(join(tmpdir(), "rw-cfg-"));
    const p = join(home, "ripplewitness.config.yaml");
    writeFileSync(p, "gate: [unclosed");
    expect(loadConfig(home, home).ok).toBe(false);
    writeFileSync(p, "gate:\n  minRecall: 9\n  minPrecision: 0.5\n");
    const bad = loadConfig(home, home);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("minRecall");
    writeFileSync(p, "nope: 1\n");
    const unknown = loadConfig(home, home);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("nope");
  });
});
