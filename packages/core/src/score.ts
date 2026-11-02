import { z } from "zod";
import type { GateConfig, GateScore, Miss, MissCause, RouteEvidence } from "./types.js";

const PredictionSchema = z.object({
  /** Dedup happens in scoring; duplicates must not inflate the score. */
  routeIds: z.array(z.string().min(1)).max(200),
  nothingElse: z.boolean(),
});

export type Prediction = z.infer<typeof PredictionSchema>;

/** Gate pass thresholds default (TRD §7.6); override per run via analyze `gate`. */
export const DEFAULT_GATE: GateConfig = { minRecall: 0.75, minPrecision: 0.5 };

export function parsePrediction(input: unknown): Prediction {
  return PredictionSchema.parse(input);
}

function causeFor(routeId: string, byId: Map<string, RouteEvidence>): MissCause {
  const ev = byId.get(routeId);
  const path = (ev?.impactPath ?? []).join(" ");
  if (path.includes("shared:db:")) return "missed_db_coupling";
  if (path.includes("shared:config:")) return "missed_config_coupling";
  if (/fn:/.test(path)) return "missed_shared_helper";
  if (ev && !ev.staticImpacted) return "implicit_contract";
  return "implicit_contract";
}

/**
 * TRD §7.6 gate scoring. Pure. Recall over observed-changed exercised
 * routes; precision over predicted routes. "Nothing else changes" passes
 * only when the observed set is empty.
 */
export function scoreGate(
  predictionInput: unknown,
  evidence: RouteEvidence[],
  config: GateConfig,
): GateScore {
  const prediction = parsePrediction(predictionInput);
  const predicted = [...new Set(prediction.routeIds)].sort();
  const observed = evidence.filter((e) => e.exercised && e.observedChanged).map((e) => e.routeId).sort();
  const observedSet = new Set(observed);
  const predictedSet = new Set(predicted);
  const byId = new Map(evidence.map((e) => [e.routeId, e]));

  const hits = predicted.filter((r) => observedSet.has(r)).sort();
  const misses: Miss[] = observed
    .filter((r) => !predictedSet.has(r))
    .map((routeId) => ({ routeId, cause: causeFor(routeId, byId) }))
    .sort((a, b) => (a.routeId < b.routeId ? -1 : 1));
  const falsePositives = predicted.filter((r) => !observedSet.has(r)).sort();

  const recall = observed.length === 0 ? 1 : hits.length / observed.length;
  const precision = predicted.length === 0 ? (observed.length === 0 ? 1 : 0) : hits.length / predicted.length;

  let passed: boolean;
  let passReason: string;
  if (prediction.nothingElse && observed.length > 0) {
    passed = false;
    passReason = "nothing_else_claimed_but_changes_observed";
  } else if (prediction.nothingElse && observed.length === 0) {
    passed = true;
    passReason = "nothing_else_correct";
  } else if (predicted.length === 0 && observed.length === 0) {
    passed = true;
    passReason = "empty_prediction_empty_observed";
  } else {
    passed = recall >= config.minRecall && precision >= config.minPrecision;
    passReason = passed ? "thresholds_met" : "thresholds_missed";
  }
  return { predicted, observed, hits, misses, falsePositives, recall, precision, passed, passReason };
}
