export type NodeStatus =
  | "CONFIRMED"
  | "CLEARED"
  | "SURPRISE"
  | "UNVERIFIED"
  | "QUIET"
  | "DIFF"
  | "CONTRADICTED"
  | "CHANGED"
  | "UNCHANGED"
  | "UNCOVERED";

/** Review mode: full fusion, replay-failed, or static-unknown (J-05). */
export type ReviewMode = "full" | "static-only" | "dynamic-only";

export type ClaimType = "SCOPE" | "BEHAVIOR_UNCHANGED" | "IMPLEMENTED" | "TESTS" | "API_COMPAT";
export type ClaimVerdict = "SUPPORTED" | "CONTRADICTED" | "UNVERIFIABLE";

export interface RouteEvidence {
  routeId: string;
  exercised: boolean;
  observedChanged: boolean;
  staticImpacted: boolean;
  inDiff: boolean;
  isNew: boolean;
  impactPath?: string[];
}

export interface ClaimEvidence {
  claimId: string;
  type: ClaimType;
  verdict: ClaimVerdict;
  /** Route ids this claim's scope covers. */
  routes: string[];
}

export interface FusedNode {
  routeId: string;
  status: NodeStatus;
  exercised: boolean;
  observedChanged: boolean;
  staticImpacted: boolean;
  inDiff: boolean;
  /** Route exists in the head graph but not the base graph. */
  isNew?: boolean;
  surprise: boolean;
  contradictedBy: string[];
}

export type MissCause =
  | "implicit_contract"
  | "missed_shared_helper"
  | "missed_config_coupling"
  | "missed_db_coupling"
  | "missed_event_coupling";

export interface Miss {
  routeId: string;
  cause: MissCause;
}

export interface GateScore {
  predicted: string[];
  observed: string[];
  hits: string[];
  misses: Miss[];
  falsePositives: string[];
  recall: number;
  precision: number;
  passed: boolean;
  passReason: string;
}

export interface GateConfig {
  minRecall: number;
  minPrecision: number;
}
