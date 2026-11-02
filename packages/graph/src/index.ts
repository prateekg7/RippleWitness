export const PACKAGE_NAME = "@ripplewitness/graph" as const;
export type { ChangedFile, EdgeConfidence, EdgeType, GraphEdge, GraphNode, ImpactResult, NodeKind, StaticGraph } from "./types.js";
export { extractStaticGraph } from "./extract.js";
export { computeImpact } from "./impact.js";
