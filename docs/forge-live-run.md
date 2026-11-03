# Forge loop, live on the demo subject (PR-07)

Recorded 2026-11-03 against this repo's working tree. The claim under test
(PRD F-15, novelty claim v1.2): the auto-loop turns UNVERIFIED nodes into
exercised ones with synthesized, execution-validated scenarios.

## Setup

- Subject: `demo/shop-api` copied to a scratch repo (committed
  `node_modules` excluded — the replay symlinks deps itself), PR-07
  applied on a branch.
- Scenarios deliberately subset to the `checkout` + `health` groups
  (9 scenarios), so the products routes PR-07 touches are observed by
  nobody.
- Analysis: all stages ok; locked an empty prediction (the gate is not
  what is being measured here).

## Before

```
route:GET /products      UNVERIFIED  exercised: False
route:GET /products/:sku UNVERIFIED  exercised: False
```

## `POST /api/runs/:id/forge/auto` (verbatim response)

```json
{
  "queued": ["route:GET /cart/:id", "route:GET /products", "route:GET /products/:sku"],
  "synthesized": 1,
  "kept": ["forge-auto-getproducts"],
  "dropped": [],
  "skipped": [
    { "routeId": "route:GET /cart/:id", "reason": "parameterized path needs human-supplied values" },
    { "routeId": "route:GET /products/:sku", "reason": "parameterized path needs human-supplied values" }
  ]
}
```

## After (re-fused)

```
route:GET /products CONFIRMED exercised: True
```

The synthesized `GET /products` scenario ran on base and head, proved
deterministic, and was kept; the re-fusion marks the route CONFIRMED
(exercised, observed-changed, statically impacted) — which is exactly
what the full 42-scenario suite independently reports for PR-07 in
`eval/results.md` (observed: `route:GET /products`).

## Honest edges

- Parameterized routes are *skipped with a stated reason*, not guessed:
  the loop earns coverage only where a parameter-free probe is safe.
  Supplying values for `:id`/`:sku` remains reviewer work.
- One route, one subject, one run. The unit/integration proof is
  CT-F15-01/02; this page is the live demonstration.
