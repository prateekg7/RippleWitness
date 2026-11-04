# Real-repo run: typicode/json-server (not our code, not our fixtures)

A genuine open-source change, reviewed end-to-end by the shipped pipeline.
First recorded 2026-11-03; re-run 2026-11-04 after the fixes described
under “What the first run exposed” below. Report output is from the re-run.

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

## What execution said (verbatim report output, 2026-11-04 re-run)

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

### Claims

No extracted claims.

### Open questions

- **48837036-1f6b-475e-8c0f-4068c806d1f4** [OPEN] `route:PUT /:name` — SCOPE_CREEP
- **5fc7a7a1-0dd3-42df-89fb-d40c43e76df8** [OPEN] `route:POST /:name` — SCOPE_CREEP
- **9df5ea0c-c1ad-4f6b-b70b-f1e3a83ef97e** [OPEN] `route:DELETE /:name/:id` — SCOPE_CREEP
- **bfd386fd-a2b1-450c-ae3d-febaa5f36416** [OPEN] `route:PATCH /:name/:id` — SCOPE_CREEP
- **e174f1fb-a114-4617-b8af-33c51f9e7d24** [OPEN] `route:PATCH /:name` — SCOPE_CREEP

---

`RippleWitness-Receipt: ed25519:1e73db159df35971:81d41a561cff`
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

## What the first run exposed — and the fixes (2026-11-04)

The 2026-11-03 run labeled the changed route SURPRISE and still claimed
L3. Inspection showed three code defects, all fixed and regression-tested:

- The extractor counted one-arg lookups (`URLSearchParams.get("_where")`)
  as routes. Route discovery now requires a `/`-path plus a handler
  argument (IT-GR-07).
- The changed line lives in the terminal `app.use('/:name')` fallback,
  which the graph never modeled. Path-mounted `app.use` handlers are now
  shared handler nodes linked from every route under the mount prefix, so
  a diff inside one statically impacts those routes (IT-GR-07).
- The pipeline exact-matched static pattern ids (`GET /:name`) against
  concrete evidence ids (`GET /definitely-missing`), so no impact ever
  transferred. Concrete routes now inherit impact (and the witness path)
  from a segment-wise matching static pattern (`inheritStaticImpact` in
  `packages/core`), and a static pass finding zero routes in **any**
  language now runs DYNAMIC-ONLY at tier L2 instead of only Python
  (IT-GR-JS-04). A manifest-less Node subject also replays now
  (dependency strategy `none` instead of a doomed frozen install).

In the re-run above, the changed route is CONFIRMED, exercised unchanged
routes are CLEARED, and the tier L3 is earned: the static half genuinely
contributed. The write-method patterns (POST/PUT/PATCH/DELETE) share the
same fallback handler, so they honestly surface as UNVERIFIED — the five
probes only exercise GET.

## Remaining limitations

- **Five hand-written probes** covered the change. Nobody recorded
  production traffic; `ripplewitness import-har` exists for teams that
  have it.
- **One repo, one commit pair.** This is an existence proof on
  third-party code, not a benchmark.
