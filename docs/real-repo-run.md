# Real-repo run: typicode/json-server (not our code, not our fixtures)

A genuine open-source change, reviewed end-to-end by the shipped pipeline.
Recorded 2026-11-03 against this repo's working tree (all gates green).

## The change under review

- Repo: <https://github.com/typicode/json-server> (MIT), cloned at `89a34a4`.
- Change: commit `8d42c40` — "Fix: return JSON response for 404 errors
  instead of plain text (#1738)". One line in `src/app.ts`:
  `res.sendStatus(404)` → `res.status(404).json({ error: 'Not Found' })`.
- Base: its parent `6ad7562` (v1.0.0-beta.14). `package.json` and
  `pnpm-lock.yaml` are identical across the pair, so replay used the
  symlink dependency strategy from a pre-installed checkout.

## Harness (disclosed, identical on both sides)

json-server does not meet the subject contract (no committed SQLite seed,
no `/health` route), so two files were committed identically on top of
both refs — they cancel out of the reviewed diff, which stays exactly the
upstream change:

- `rw-db.json` (committed here as [rw-db.json](rw-db.json)): posts,
  comments, and a `health` collection — json-server serves db keys as
  routes, so `GET /health` returns 200. The replay data fixture.
- `seed/seed.db`: a one-table SQLite file (the replay seed contract).

Scenarios (in [scenarios/](scenarios/)): `posts-list`, `post-one`,
`comments-filter`, `health-probe`, `missing-404` — five GET probes.

Run input:

```json
{
  "repoPath": "<clone>",
  "baseRef": "rw-base",
  "headRef": "rw-head",
  "scenariosDir": "docs/real-repo/scenarios",
  "seedDbRel": "seed/seed.db",
  "appStart": ["node", "--experimental-strip-types", "src/bin.ts", "rw-db.json"],
  "flakeGuard": false
}
```

(`rw-base`/`rw-head` are the upstream commits plus the harness commit.
The server ran with no `META_API_KEY`: deterministic path only, claims
stage honestly `degraded`.)

## What the reviewer did

Read the upstream diff, predicted exactly one behavioral change — the
404 error path — and locked:

```json
{ "routeIds": ["route:GET /definitely-missing"], "nothingElse": false }
```

## What execution said (verbatim report output)

## RippleWitness report — `rw-base..rw-head`

Status: **ready** · mode: full · assurance: **L3**

### Gate

**PASS** — recall 1.00, precision 1.00 (thresholds_met)

### Observed blast radius

| route | status | exercised | static | surprise |
| --- | --- | --- | --- | --- |
| route:GET /comments | QUIET | yes | no | no |
| route:GET /definitely-missing | SURPRISE | yes | no | yes |
| route:GET /health | QUIET | yes | no | no |
| route:GET /posts | QUIET | yes | no | no |
| route:GET /posts/:id | QUIET | yes | no | no |

### Unverified

None — every fused route was exercised.

### Claims

No extracted claims.

### Open questions

- **7f0fa67f-65b4-40c6-946c-a789b929fccf** [OPEN] `route:GET /definitely-missing` — SURPRISE_RIPPLE

---

`RippleWitness-Receipt: ed25519:84c6fc8a44392114:380eab073aa4`
_Rendered from observed evidence. Agent prose is never evidence._

## Receipt, verified the way CI verifies it

Issued with `{ "algorithm": "ed25519" }`. Note `agentMode: not_asked` in
the payload — no question was asked in this run, and the receipt says so.
Then, against a plain checkout of the head commit:

```sh
RIPPLEWITNESS_PUBKEY_PEM="$(cat .ripplewitness/signing.pub)" \
  node ci-action/verify-receipt.mjs <clone>
# VALID tier:L3
```

The first issuance attempt failed this check (`head_mismatch`) because
receipts bound the ref *spelling*; receipts now bind resolved SHAs
(`resolveRef` in `apps/server/src/receipts.ts`, regression-tested). That
bug was found by this run, not by the test suite.

## Evidence summary (what exists, labeled by kind)

| Run | Subject | Kind | Outcome |
|---|---|---|---|
| json-server `8d42c40` (this page) | third-party, upstream fix | live, human prediction locked pre-reveal | gate 1.00/1.00; receipt `VALID tier:L3` in CI mode |
| Python subject (IT-REP-11/12 + E6) | our fixtures (`demo/shop-api-py`) | committed integration suite + `pnpm eval` | observed changes match designed labels; deterministic |
| Go subject (IT-REP-GO-01) | our fixtures (`demo/shop-api-go`) | committed integration suite | PR-GO-00 ripple on cart + reports; health unchanged |
| JS subject (IT-GR-JS, IT-REP-12) | our fixtures (`demo/shop-api-js`) | committed integration suite | same 12 routes as TS; deterministic |

Only the first row is third-party code; the rest prove the polyglot
pipeline end-to-end on fixtures we control. We do not claim otherwise.

## Honest limitations this run exposed

- **Static blindness is real.** json-server registers routes from db keys
  at runtime; the static pass finds none of them, so every observed change
  is SURPRISE by construction and the fusion's static half contributes
  nothing. Replay plus the scenario suite carried the review. On subjects
  like this, treat RippleWitness as execution-led (the report's tier
  stays L3 because replay was deterministic, not because the map helped).
- **Five hand-written probes** covered the change. Nobody recorded
  production traffic; `ripplewitness import-har` exists for teams that
  have it.
- **One repo, one commit pair, one run.** This is an existence proof on
  third-party code, not a benchmark.
