export type NodeKind = "route" | "handler" | "service" | "db_table" | "config";
export type EdgeType = "calls" | "reads" | "writes" | "config";
export type EdgeConfidence = "EXTRACTED" | "INFERRED";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Repo-relative path, e.g. "src/app.ts". Absent for db_table nodes. */
  file?: string;
  /** 1-based [startLine, endLine] of the definition/registration. */
  range?: [number, number];
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  confidence: EdgeConfidence;
}

export interface StaticGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Changed (added) line numbers in the NEW tree, grouped by repo-relative file. */
export interface ChangedFile {
  file: string;
  lines: number[];
}

export interface ImpactResult {
  /** Node ids whose own range intersects the diff. */
  inDiff: string[];
  /** inDiff + reverse-reachable callers (depth<=3) + db/config sharers. */
  staticImpacted: string[];
  /** One witness path per impacted node (node id chains). */
  paths: Record<string, string[]>;
}
