# RippleWitness

A local-first review cockpit for Muse Code pull requests. It fuses a static
impact graph with differential replay, grades your impact prediction against
execution, cross-examines the agent with evidence-anchored questions, and
issues a tamper-evident review receipt.

Built for the Meta Global AI Developer Hackathon (Indie track). Status: working
v1 for the stated scope (local, single-user, TypeScript/Express/SQLite subject
apps). Numbers below come only from `pnpm eval` — see [eval/results.md](eval/results.md).

## Quickstart

Prerequisites: Node 22+, git, and `corepack` (ships with Node).

```sh
corepack pnpm i
corepack pnpm demo:prepare     # seed the demo shop-api database
corepack pnpm dev              # server :4400 + web :5173
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) in a browser, then review the
hero PR: repo path `<checkout>/demo/shop-api` does not apply directly — the
catalog ships as patches in `demo/prs/`; apply one on a scratch branch of a
subject repo and point the UI at it (see [docs/DEMO.md](docs/DEMO.md)).

Without `META_API_KEY`, everything deterministic works (map, replay, gate,
questions, receipt); LLM assistants (claims, Q&A resolution, reviewer,
explainer, summary) honestly report `NO-LLM` mode.

```sh
corepack pnpm lint && corepack pnpm typecheck
corepack pnpm test             # unit (fast, no network)
corepack pnpm test:int         # integration (spawns servers; needs localhost)
corepack pnpm eval             # benchmark -> eval/results.md (~3 min)
```

## How it works

1. **Observed Blast Radius** — static call/db/config graph × differential
   replay of a curated scenario suite. Statuses are computed in code:
   CONFIRMED / CLEARED / SURPRISE / UNVERIFIED / QUIET / DIFF / CONTRADICTED.
2. **Predict-the-Ripple Gate** — you predict the impact set before the reveal;
   recall/precision are execution-graded, misses get a cause taxonomy.
3. **Cross-Examination** — agent claims are extracted, verified
   deterministically, and challenged with evidence-anchored questions; answers
   are re-verified (RESOLVED / CONTESTED / OPEN).
4. **Review Receipt** — HMAC-signed record bound to the diff + scenario suite,
   stored as a git note; `ripplewitness verify` and the pre-push hook enforce it.

P1 features: blind-first AI review, canary hunks (execution-validated
mutations), hunk explainer, evidence-only summaries, strict-mode hook.

## Layout

- `apps/server` — pipeline + REST API + CLI (`doctor|serve|verify|hook`)
- `apps/web` — React cockpit (Vite)
- `packages/{core,graph,replay,crossexam,agents,receipt,canary}` — pipeline stages
- `demo/shop-api` — deterministic subject app (12 routes, event bus, seeded SQLite)
- `demo/scenarios` — 42 replay fixtures; `demo/prs` — 8 hand-authored PR patches + labels
- `eval/` — benchmark harness; `docs/` — spikes, demo script, submission notes

Spec docs: `PRD.md`, `TRD.md`, `ARCHITECTURE.md`, `TASKS.md`, `TESTS_AND_BUGS.md`,
`AUDIT.md`, `AGENTS.md`. Cost rule: agent runs/prompts are reused from the
session store, never regenerated; fixtures are hand-authored (AGENTS §A5b).
