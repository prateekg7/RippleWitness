import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FusedNode } from "@ripplewitness/core";
import { openStore, putArtifact } from "./store.js";
import { renderReport } from "./report.js";

function seed(locked: boolean): { db: ReturnType<typeof openStore>; runId: string } {
  const dir = mkdtempSync(join(tmpdir(), "rw-report-"));
  const db = openStore(join(dir, "runs.db"));
  db.prepare(
    "INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, prediction, score, locked, overrideReason, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "r1",
    "/repo",
    "base00000000",
    "head11111111",
    "ready",
    "{}",
    JSON.stringify({ routeIds: ["route:GET /a"] }),
    JSON.stringify({ recall: 1, precision: 0.5, passed: true, passReason: "thresholds_met" }),
    locked ? 1 : 0,
    null,
    new Date().toISOString(),
  );
  const fused: FusedNode[] = [
    { routeId: "route:GET /a", status: "SURPRISE", exercised: true, observedChanged: true, staticImpacted: false, inDiff: false, surprise: true, contradictedBy: [] },
    { routeId: "route:GET /b|c", status: "UNVERIFIED", exercised: false, observedChanged: false, staticImpacted: true, inDiff: false, surprise: false, contradictedBy: [] },
  ];
  putArtifact(db, "r1", "fused", fused);
  putArtifact(db, "r1", "claims", [{ claimId: "c1", verdict: "SUPPORTED" }]);
  putArtifact(db, "r1", "reviewMode", "full");
  putArtifact(db, "r1", "assuranceTier", "L3");
  db.prepare("INSERT INTO questions (id, runId, template, routeId, status) VALUES (?, ?, ?, ?, ?)").run(
    "q1",
    "r1",
    "Why did /a change?\nsecond line",
    "route:GET /a",
    "OPEN",
  );
  return { db, runId: "r1" };
}

describe("PR-bot report mode (M-09)", () => {
  it("CT-RPT-01: renders gate, blast radius, claims, questions from artifacts", () => {
    const { db, runId } = seed(true);
    const out = renderReport(db, runId);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const md = out.markdown;
    expect(md).toContain("## RippleWitness report");
    expect(md).toContain("**PASS** — recall 1.00, precision 0.50");
    expect(md).toContain("| route:GET /a | SURPRISE | yes | no | yes |");
    // Pipes and newlines are escaped so tables cannot break.
    expect(md).toContain("route:GET /b\\|c");
    expect(md).toContain("### Unverified");
    expect(md).toContain("route:GET /b\\|c");
    expect(md).toContain("| c1 | SUPPORTED |");
    expect(md).toContain("**q1** [OPEN]");
    expect(md).toContain("Why did /a change?");
    expect(md).toContain("Agent prose is never evidence");
  });

  it("CT-RPT-02: 423 before lock, 404 for unknown runs", () => {
    const { db } = seed(false);
    expect(renderReport(db, "r1")).toEqual({ ok: false, status: 423, error: "prediction_locked_required" });
    expect(renderReport(db, "nope")).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});
