export const PACKAGE_NAME = "@ripplewitness/core" as const;
export type {
  ClaimEvidence,
  ClaimType,
  ClaimVerdict,
  FusedNode,
  GateConfig,
  GateScore,
  Miss,
  MissCause,
  NodeStatus,
  RouteEvidence,
} from "./types.js";
export { fuseRoutes } from "./fuse.js";
export type { Prediction } from "./score.js";
export { DEFAULT_GATE, parsePrediction, scoreGate } from "./score.js";
