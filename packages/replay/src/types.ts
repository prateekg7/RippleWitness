export interface StepObservation {
  scenarioId: string;
  stepIndex: number;
  method: string;
  path: string;
  status: number;
  /** Parsed JSON body, or raw text when the body is not JSON. */
  body: unknown;
  headers: Record<string, string>;
}

export interface SideResult {
  steps: StepObservation[];
  /** group -> table -> sha256 hex */
  dbHash: Record<string, Record<string, string>>;
  outbound: string[];
  /** Route ids from `GET /__routes` (best-effort; [] when absent). */
  routes: string[];
}

export type ReplayResult =
  | { ok: true; base: SideResult; head: SideResult; elapsedMs: number }
  | { ok: false; error: { stage: string; message: string } };

export interface ReplayOptions {
  /** Subject repo checkout containing baseRef and headRef. */
  repoPath: string;
  baseRef: string;
  headRef: string;
  /** Absolute scenarios directory (JSON files). */
  scenariosDir: string;
  /** Absolute path of the seed DB inside the subject repo (relative ok, resolved per worktree). */
  seedDbRel: string;
  /** Subdirectory of the subject repo that is the app ("." if repo root). */
  appDir?: string;
  /** Start command argv, e.g. ["corepack", "pnpm", "start"]. */
  appStart?: string[];
  /** Preferred ports; falls back to free ports on conflict. */
  ports?: { base: number; head: number };
  workRoot?: string;
  stepTimeoutMs?: number;
  healthTimeoutMs?: number;
  /** Extra env allow-list entries merged over the replay env. */
  env?: Record<string, string>;
  /** Subject language (TRD §7.2). Default "node" preserves v1 behavior. */
  language?: "node" | "python" | "go";
}
