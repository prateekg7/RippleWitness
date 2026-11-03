import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "./store.js";
import { getCalibration, hashReviewer, recordCalibration } from "./calibration.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rw-cal-"));
  const file = join(dir, "runs.db");
  return { db: openStore(file), file };
}

describe("calibration memory F-17 (CT-CAL-01)", () => {
  it("returns an empty checklist with no history", () => {
    const { db } = setup();
    const c = getCalibration(db, hashReviewer("local"));
    expect(c.runs).toBe(0);
    expect(c.checklist).toEqual([]);
    expect(c.surpriseMissRate).toBeNull();
  });

  it("aggregates histogram, F1 trend, and surprise rate across runs", () => {
    const { db } = setup();
    const h = hashReviewer("ada");
    recordCalibration(db, h, {
      runId: "r1",
      ts: "2026-01-01T00:00:00Z",
      recall: 0.5,
      precision: 1,
      misses: [{ routeId: "route:A", cause: "missed_db_coupling" }],
      surpriseMissed: true,
    });
    recordCalibration(db, h, {
      runId: "r2",
      ts: "2026-01-02T00:00:00Z",
      recall: 1,
      precision: 1,
      misses: [],
      surpriseMissed: false,
    });
    const c = getCalibration(db, h);
    expect(c.runs).toBe(2);
    expect(c.causeHistogram.missed_db_coupling).toBe(1);
    expect(c.f1Trend).toHaveLength(2);
    expect(c.f1Trend[1]).toBeCloseTo(1);
    expect(c.surpriseMissRate).toBeCloseTo(0.5);
    expect(c.checklist).toHaveLength(1);
    expect(c.checklist[0]).toContain("db couplings");
    expect(c.checklist[0]).toContain("2 past reviews");
  });

  it("checks top-two causes and isolates reviewers", () => {
    const { db } = setup();
    recordCalibration(db, hashReviewer("ada"), {
      runId: "r1",
      ts: "2026-01-01T00:00:00Z",
      recall: 0,
      precision: 0,
      misses: [
        { routeId: "a", cause: "implicit_contract" },
        { routeId: "b", cause: "implicit_contract" },
        { routeId: "c", cause: "missed_event_coupling" },
      ],
      surpriseMissed: false,
    });
    const ada = getCalibration(db, hashReviewer("ada"));
    expect(ada.checklist).toHaveLength(2);
    expect(ada.checklist[0]).toContain("implicit contracts");
    const bob = getCalibration(db, hashReviewer("bob"));
    expect(bob.runs).toBe(0);
  });

  it("never stores the raw reviewer name", () => {
    const { db, file } = setup();
    recordCalibration(db, hashReviewer("ada-lovelace-9x"), {
      runId: "r1",
      ts: "2026-01-01T00:00:00Z",
      recall: 1,
      precision: 1,
      misses: [],
      surpriseMissed: false,
    });
    db.close();
    expect(readFileSync(file).includes("ada-lovelace-9x")).toBe(false);
  });
});
