import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Miss, MissCause } from "@ripplewitness/core";

export interface CalibrationEntry {
  runId: string;
  ts: string;
  recall: number;
  precision: number;
  misses: Miss[];
  surpriseMissed: boolean;
}

export interface CalibrationSummary {
  runs: number;
  f1Trend: number[];
  causeHistogram: Record<MissCause, number>;
  surpriseMissRate: number | null;
  checklist: string[];
}

/** Reviewers are stored hashed: calibration is local-only, never a leaderboard (AUDIT §4). */
export function hashReviewer(reviewer: string): string {
  return createHash("sha256").update(`ripplewitness-reviewer:${reviewer}`).digest("hex");
}

const HINTS: Record<MissCause, string> = {
  implicit_contract: "your past misses were implicit contracts — check event/config couplings this review",
  missed_shared_helper: "your past misses were shared helpers — trace the callees of touched code",
  missed_config_coupling: "your past misses were config couplings — check config values read by other routes",
  missed_db_coupling: "your past misses were db couplings — check tables written here but read elsewhere",
  missed_event_coupling: "your past misses were event couplings — check bus subscribers of emitted events",
};

export function recordCalibration(db: Database.Database, reviewerHash: string, entry: CalibrationEntry): void {
  db.prepare(
    "INSERT INTO calibration (reviewerHash, runId, ts, recall, precision, misses, surpriseMissed) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(reviewerHash, entry.runId, entry.ts, entry.recall, entry.precision, JSON.stringify(entry.misses), entry.surpriseMissed ? 1 : 0);
}

/**
 * Aggregate a reviewer's past runs only. The checklist names cause
 * frequencies, never the current run's observed set (anti-anchoring safe).
 */
export function getCalibration(db: Database.Database, reviewerHash: string, limit = 20): CalibrationSummary {
  const rows = db
    .prepare("SELECT ts, recall, precision, misses, surpriseMissed FROM calibration WHERE reviewerHash = ? ORDER BY ts DESC LIMIT ?")
    .all(reviewerHash, limit) as { ts: string; recall: number; precision: number; misses: string; surpriseMissed: number }[];
  const histogram: Record<MissCause, number> = {
    implicit_contract: 0,
    missed_shared_helper: 0,
    missed_config_coupling: 0,
    missed_db_coupling: 0,
    missed_event_coupling: 0,
  };
  let surprise = 0;
  for (const r of rows) {
    surprise += r.surpriseMissed;
    for (const m of JSON.parse(r.misses) as Miss[]) {
      histogram[m.cause] = (histogram[m.cause] ?? 0) + 1;
    }
  }
  const f1Trend = rows
    .slice()
    .reverse()
    .map((r) => (r.precision + r.recall === 0 ? 0 : (2 * r.precision * r.recall) / (r.precision + r.recall)));
  const top = (Object.entries(histogram) as [MissCause, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return {
    runs: rows.length,
    f1Trend,
    causeHistogram: histogram,
    surpriseMissRate: rows.length === 0 ? null : surprise / rows.length,
    checklist:
      rows.length === 0
        ? []
        : top.map(([cause, n]) => `Calibration (${rows.length} past review${rows.length === 1 ? "" : "s"}): ${HINTS[cause]} (${n} miss${n === 1 ? "" : "es"})`),
  };
}
