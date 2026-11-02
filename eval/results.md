# RippleWitness eval results

Generated: 2026-11-02T19:56:32.042Z by `pnpm eval` (eval/run.ts). Tree: uncommitted working tree.
Scenarios: 42. No LLM calls in this harness (deterministic path only).

## E1 — differential replay vs designed labels

| PR | observed (brute-force) | designed observed | match | static-impacted routes |
|---|---|---|---|---|
| PR-00 | route:GET /orders, route:GET /reports/sales, route:POST /checkout | route:POST /checkout, route:GET /orders, route:GET /orders/:id, route:GET /reports/sales | **NO** | route:GET /cart/:id, route:GET /orders, route:GET /orders/:id, route:POST /cart, route:POST /checkout |
| PR-01 | ∅ | ∅ | YES | ∅ |
| PR-02 | ∅ | ∅ | YES | route:GET /cart/:id, route:GET /orders, route:GET /orders/:id, route:GET /shipping/quote, route:POST /cart, route:POST /checkout |
| PR-03 | route:POST /discounts/validate | route:POST /discounts/validate | YES | route:POST /discounts/validate |
| PR-04 | route:GET /orders, route:GET /orders/:id, route:GET /reports/sales, route:POST /checkout | route:POST /checkout, route:GET /orders, route:GET /orders/:id, route:GET /reports/sales | YES | route:POST /checkout |
| PR-05 | route:GET /orders, route:GET /orders/:id, route:GET /reports/sales, route:GET /shipping/quote, route:POST /checkout | route:POST /checkout, route:GET /orders, route:GET /orders/:id, route:GET /shipping/quote, route:GET /reports/sales | YES | route:GET /shipping/quote, route:POST /checkout |
| PR-07 | route:GET /products | route:GET /products | YES | route:GET /cart/:id, route:GET /products, route:GET /products/:sku, route:POST /checkout |
| PR-09 | route:GET /reports/sales | route:GET /reports/sales | YES | route:GET /reports/sales |

Static-vs-observed micro-average: precision 0.40, recall 0.53 (TP 8, FP 12, FN 7).

## E2 — determinism + cost

- Base-vs-base full replay twice byte-identical: **YES**
- LLM calls in deterministic path: 0 ($0). Review-time LLM calls are capped per run (NFR-05) and unmeasured here.

## E3 — claim verifier accuracy (20 seeded)

| claim | PR | expected | got |
|---|---|---|---|
| C01 | PR-00 | CONTRADICTED | CONTRADICTED |
| C02 | PR-00 | SUPPORTED | SUPPORTED |
| C03 | PR-00 | SUPPORTED | SUPPORTED |
| C04 | PR-00 | CONTRADICTED | CONTRADICTED |
| C05 | PR-01 | SUPPORTED | SUPPORTED |
| C06 | PR-01 | CONTRADICTED | CONTRADICTED |
| C07 | PR-03 | SUPPORTED | SUPPORTED |
| C08 | PR-03 | SUPPORTED | SUPPORTED |
| C09 | PR-04 | CONTRADICTED | CONTRADICTED |
| C10 | PR-04 | SUPPORTED | SUPPORTED |
| C11 | PR-05 | SUPPORTED | SUPPORTED |
| C12 | PR-05 | CONTRADICTED | CONTRADICTED |
| C13 | PR-07 | CONTRADICTED | CONTRADICTED |
| C14 | PR-07 | SUPPORTED | SUPPORTED |
| C15 | PR-09 | SUPPORTED | SUPPORTED |
| C16 | PR-09 | CONTRADICTED | CONTRADICTED |
| C17 | PR-03 | CONTRADICTED | CONTRADICTED |
| C18 | PR-07 | CONTRADICTED | CONTRADICTED |
| C19 | PR-01 | SUPPORTED | SUPPORTED |
| C20 | PR-09 | CONTRADICTED | CONTRADICTED |

Accuracy: 20/20. False CONTRADICTED: 0 (target ≤10%, i.e. ≤2).

## E5 — canary execution validation (single attempt)

- flip_cmp @src/app.ts:28 → ACCEPTED (observable change on 5 route(s); routes: route:GET /orders, route:GET /orders/:id, route:GET /reports/sales, route:GET /shipping/quote, route:POST /checkout)
- Catch rate needs human trials; not measured here.

Harness wall time: 171s.