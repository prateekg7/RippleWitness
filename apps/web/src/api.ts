export interface LockedRun {
  repoPath: string;
  baseRef: string;
  headRef: string;
  scenariosDir: string;
  seedDbRel?: string;
  appStart?: string[];
}

export interface MapNode {
  routeId: string;
  staticImpacted: boolean;
  inDiff: boolean;
  exercised: boolean;
  status?: string;
  observedChanged?: boolean;
}

export interface Reveal {
  score: {
    predicted: string[];
    observed: string[];
    hits: string[];
    misses: { routeId: string; cause: string }[];
    falsePositives: string[];
    recall: number;
    precision: number;
    passed: boolean;
    passReason: string;
  };
  overrideReason: string | null;
  nodes: (MapNode & { status: string })[];
  claims: { claimId: string; type: string; text: string; verdict: string; routes: string[] }[];
  questions: Question[];
  reviewMode: string;
}

export interface Question {
  id: string;
  template: string;
  routeId: string | null;
  claimId: string | null;
  status: string;
  askedCount: number;
  answer: string | null;
  need: number;
  text: string | null;
  anchors: string[];
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(await res.json().catch(() => ({})))}`);
  return (await res.json()) as T;
}

export const api = {
  config: () =>
    fetch("/api/config").then(
      j<{ lockedRun: LockedRun | null; capabilities?: { llm: boolean; agentSession: string } }>,
    ),
  runs: () => fetch("/api/runs").then(j<{ runs: { id: string; status: string; createdAt: string }[] }>),
  analyze: (body: object) =>
    fetch("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      j<{ runId: string }>,
    ),
  status: (runId: string) => fetch(`/api/runs/${runId}/status`).then(j<{ status: string; stages: string; locked: number }[]> as never) as Promise<{ status: string; stages: string; locked: number; reviewMode: string }>,
  map: (runId: string) => fetch(`/api/runs/${runId}/map`).then(j<{ nodes: MapNode[]; calibration?: string[] }>),
  predict: (runId: string, body: { routeIds: string[]; nothingElse: boolean }) =>
    fetch(`/api/runs/${runId}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<{ locked: boolean }>),
  reveal: (runId: string) => fetch(`/api/runs/${runId}/reveal`).then(j<Reveal>),
  override: (runId: string, reason: string) =>
    fetch(`/api/runs/${runId}/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    }).then(j<{ overridden: boolean }>),
  agentMessage: (runId: string, text: string) =>
    fetch(`/api/runs/${runId}/agent-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(j<{ claims: Reveal["claims"] }>),
  ask: (runId: string, qid: string) =>
    fetch(`/api/runs/${runId}/questions/${qid}/ask`, { method: "POST" }).then(
      j<{ status: string; followup?: string; terminal?: boolean }>,
    ),
  receipt: (runId: string) =>
    fetch(`/api/runs/${runId}/receipt`, { method: "POST" }).then(j<{ receipt: object; trailer: string }>),
  canary: (runId: string, file: string) =>
    fetch(`/api/runs/${runId}/canary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    }).then(j<{ candidate: { file: string; line: number; operator: string }; verdict: { accepted: boolean; reason: string; changedRoutes: string[] } }>),
  findings: (runId: string, findings: { file: string; startLine: number; endLine: number; note: string }[]) =>
    fetch(`/api/runs/${runId}/findings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ findings }),
    }).then(j<{ recorded: number }>),
  aiReview: (runId: string) =>
    fetch(`/api/runs/${runId}/ai-review`, { method: "POST" }).then(
      j<{ valid: { file: string; startLine: number; endLine: number; severity: string; note: string }[]; rejected: unknown[] }>,
    ),
  explain: (runId: string, routeId: string) =>
    fetch(`/api/runs/${runId}/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeId }),
    }).then(j<{ explanation: { summary: string; confidence: string } }>),
  summary: (runId: string) =>
    fetch(`/api/runs/${runId}/summary`, { method: "POST" }).then(
      j<{ summary: { title: string; body: string; unverified: string[] } }>,
    ),
  fnrun: (runId: string, body: { fn: string; args?: unknown[]; predictedBase?: unknown; predictedHead?: unknown }) =>
    fetch(`/api/runs/${runId}/fn-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(
      j<{
        fn: string;
        base: { ok: boolean; value: unknown };
        head: { ok: boolean; value: unknown };
        baseHit: boolean | null;
        headHit: boolean | null;
        changed: boolean | null;
      }>,
    ),
  autoforge: (runId: string) =>
    fetch(`/api/runs/${runId}/forge/auto`, { method: "POST" }).then(
      j<{ queued: string[]; synthesized: number; kept: string[]; dropped: { id: string; reason: string }[] }>,
    ),
  diff: (runId: string) =>
    fetch(`/api/runs/${runId}/diff`).then(
      j<{
        files: {
          file: string;
          truncated: boolean;
          hunks: { header: string; lines: { type: string; text: string; oldNo: number | null; newNo: number | null }[] }[];
        }[];
      }>,
    ),
  ablations: (runId: string, routeId: string) =>
    fetch(`/api/runs/${runId}/ablations?routeId=${encodeURIComponent(routeId)}`).then(
      j<{ routeId: string; candidates: { kind: string; file: string; event?: string; reason: string }[] }>,
    ),
  ablate: (runId: string, body: { routeId: string; kind: string; file: string; event?: string }) =>
    fetch(`/api/runs/${runId}/ablate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<{ verdict: string; detail: string; changedAfter: boolean | null }>),
  metrics: (runId: string) =>
    fetch(`/api/runs/${runId}/metrics`).then(
      j<{
        metrics: {
          calls: number;
          transportRetries: number;
          schemaRepairs: number;
          timeouts: number;
          tokensIn: number;
          tokensOut: number;
          latencyMs: number;
          cacheHits: number;
          fallbackCalls: number;
          models: Record<string, number>;
          perAgent: Record<string, { calls: number; schemaValid: number; repairs: number }>;
        };
      }>,
    ),
};
