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
  analyze: (body: object) =>
    fetch("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      j<{ runId: string }>,
    ),
  status: (runId: string) => fetch(`/api/runs/${runId}/status`).then(j<{ status: string; stages: string; locked: number }[]> as never) as Promise<{ status: string; stages: string; locked: number }>,
  map: (runId: string) => fetch(`/api/runs/${runId}/map`).then(j<{ nodes: MapNode[] }>),
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
};
