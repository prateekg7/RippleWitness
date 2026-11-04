---
title: RippleWitness Demo
emoji: 🌊
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# RippleWitness

A local-first review cockpit for Muse Code pull requests. It fuses a static
impact graph with differential replay, grades your impact prediction against
execution, cross-examines the agent with evidence-anchored questions, and
issues a tamper-evident review receipt.

Built for the Meta Global AI Developer Hackathon (Indie track). Status: working
v1 for the stated scope (local, single-user; TypeScript/Express/SQLite,
plain-JS Node, Python/Flask-pattern, and Go `net/http` subject apps, plus ML
tolerance / compute-scenario / pytest-harvest support). Numbers below come
only from `pnpm eval` — see [eval/results.md](eval/results.md).

## The 60-second version

The agent says *"only touches checkout."* RippleWitness doesn't grade the
sentence — it replays the change and checks. On the hero PR, execution shows
`/reports/sales` changed too, through an event-bus coupling the static map
cannot see. The reviewer had to predict the blast radius *before* that
reveal; the prediction is scored against execution, and the resulting
receipt is bound to the exact diff.

| Claim | Execution said | Evidence |
|---|---|---|
| "Only touches checkout" (PR-00) | **CONTRADICTED** — `/reports/sales` moved via the dormant `discount.applied` subscriber | [eval/results.md](eval/results.md) E1/E3 (verifiers 20/20) |
| Static map = the impact set | Map alone: precision 0.40, recall 0.53 — useful, not ground truth | [eval/results.md](eval/results.md) E1 |
| "Nothing else changes" is checkable | Replay matched designed behavior on 7/8 catalog PRs; the 8th is the documented PR-00 coupling | [eval/results.md](eval/results.md) E1 |
| Works on code we didn't write | Real upstream fix in `typicode/json-server`: predicted exactly the 404 change; gate 1.00/1.00; ed25519 receipt `VALID` in CI mode | [docs/real-repo-run.md](docs/real-repo-run.md) |
| UNVERIFIED is a to-do, not a dead end | Forge loop synthesized `GET /products`, flipped UNVERIFIED → CONFIRMED live | [docs/forge-live-run.md](docs/forge-live-run.md) |

What a finished review looks like — the verbatim report for the json-server
run above (no installation needed to judge it):

## RippleWitness report — `rw-base..rw-head`

Status: **ready** · mode: full · assurance: **L3**

### Gate

**PASS** — recall 1.00, precision 1.00 (thresholds_met)

### Observed blast radius

| route | status | exercised | static | surprise |
| --- | --- | --- | --- | --- |
| route:DELETE /:name/:id | UNVERIFIED | no | yes | no |
| route:GET /comments | CLEARED | yes | yes | no |
| route:GET /definitely-missing | CONFIRMED | yes | yes | no |
| route:GET /health | CLEARED | yes | yes | no |
| route:GET /posts | CLEARED | yes | yes | no |
| route:GET /posts/:id | CLEARED | yes | yes | no |
| route:PATCH /:name | UNVERIFIED | no | yes | no |
| route:PATCH /:name/:id | UNVERIFIED | no | yes | no |
| route:POST /:name | UNVERIFIED | no | yes | no |
| route:PUT /:name | UNVERIFIED | no | yes | no |
| route:PUT /:name/:id | UNVERIFIED | no | yes | no |

### Unverified

- `route:DELETE /:name/:id`
- `route:PATCH /:name`
- `route:PATCH /:name/:id`
- `route:POST /:name`
- `route:PUT /:name`
- `route:PUT /:name/:id`

`RippleWitness-Receipt: ed25519:1e73db159df35971:81d41a561cff`

## Quickstart

Prerequisites: **macOS or Linux**, Node 22+, git, and `corepack` (ships with
Node). Windows is not supported (symlinked dependency trees and
process-group teardown assume POSIX). The first `corepack pnpm i` needs
network; after that, everything below runs locally.

Reviewer config (optional): drop a `ripplewitness.config.yaml` in
`$RIPPLEWITNESS_HOME` or the server's working directory to tune the gate
thresholds, question tone, explainer length, and summary style — every key
is consumed, and unknown keys fail fast at startup.

```sh
corepack pnpm i
corepack pnpm demo             # hero subject + server :4400 + web :5173
```

(`pnpm demo` prepares the PR-00 scratch repo and prints the exact New
review fields; beats in [docs/DEMO.md](docs/DEMO.md). Prefer manual
control? `corepack pnpm demo:prepare && corepack pnpm dev`.)

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
corepack pnpm test:e2e         # Playwright browser suite (E2E-01..08, E2E-11)
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
   are re-verified (RESOLVED / CONTESTED / OPEN). The question channel talks
   to the agent through the `AgentSessionPort`; without a wired session the
   ask reports "not verified" and questions stay OPEN (no fake answers).
4. **Review Receipt** — HMAC-signed by default (ed25519 on request) record
   bound to the diff + scenario suite, stored as a git note;
   `ripplewitness verify` and the pre-push hook enforce it; the CI action
   verifies both algorithms.

P1 features: blind-first AI review, canary hunks (execution-validated
mutations), hunk explainer, evidence-only summaries, strict-mode hook.
Roadmap slices shipped: Go extractor, `GET /api/runs/:id/report` (PR-comment
markdown), `ripplewitness import-har` (recorded traffic → scenarios),
`externalGraph` review input for unsupported languages.

## Layout

- `apps/server` — pipeline + REST API + CLI (`doctor|serve|verify|hook|draft-scenarios|import-har`)
- `apps/web` — React cockpit (Vite)
- `packages/{core,graph,replay,crossexam,agents,receipt,canary}` — pipeline stages
- `demo/shop-api` — deterministic subject app (12 routes, event bus, seeded SQLite)
- `demo/scenarios` — 42 replay fixtures; `demo/prs` — 8 hand-authored PR patches + labels
- `eval/` — benchmark harness; `docs/` — spikes, live-run evidence, bug log, demo script, submission notes

Planning docs (`PRD.md`, `TRD.md`, …) live with the author, not in this repo.
Cost rule: agent runs/prompts are reused from the session store, never
regenerated; fixtures are hand-authored.
