# Hosting the real-repo demo (locked single-subject)

One curated, interactive run — the typicode/json-server review from
[real-repo-run.md](real-repo-run.md) — served so anyone can open a link,
press Analyze, lock a prediction, and get the graded reveal. The subject
repo, refs, and scenarios are locked server-side; visitors cannot point
the instance at other repositories or paths.

## Abuse limits and key handling (built in, locked mode only)

- `POST /api/analyze`: at most **6 per hour per IP**, and at most **2
  concurrent analyses** — excess requests get `429 {"error":"rate_limited"}`
  or `{"error":"busy"}`. General API: 600 requests / 5 min / IP.
- On first boot with an empty store, the server seeds one analysis so the
  run list already contains a completed run; visitors can open it, lock
  their own prediction, and get the graded reveal (or start a fresh run).
- `META_API_KEY` (if set) exists only in the server process. It is never
  returned by any endpoint (`/api/config` exposes only the locked subject),
  never logged, and never sent to the browser.

## What a judge does

1. Open the URL. The New review form is pre-filled and locked.
2. Optionally open the **recorded run** listed under the form first.
3. Press **Analyze**, wait for `ready`.
4. Tick the routes they believe changed (the recorded answer:
   `route:GET /definitely-missing`), lock the prediction.
5. Read the graded reveal (CONFIRMED/CLEARED/UNVERIFIED), open a question,
   and read the report with its `RippleWitness-Receipt:` trailer.

## What runs

- `Dockerfile` builds the workspace, builds the web UI, and bakes the
  subject into the image (`scripts/prepare-hosted.mjs` clones
  json-server at the pinned commits, adds the disclosed harness files
  identically to both refs, installs subject dependencies).
- `docker-compose.yml` runs one service: web on `5173` (proxies `/api`
  to the server on `4400` inside the container), run state in the
  `rw-data` volume (`RIPPLEWITNESS_HOME=/data`).
- `RIPPLEWITNESS_LOCKED_RUN` forces every `/api/analyze` to the locked
  subject; client-supplied paths/refs are ignored. Set it only via
  environment, never commit a variant with secrets.

## Deploy (any Docker host)

```sh
docker compose build
docker compose up -d
curl -s http://127.0.0.1:5173/api/config   # shows the locked run
```

Put it behind your platform's HTTPS (VPS reverse proxy, Fly.io,
Render, a tunnel — your choice). The app itself is plain HTTP on 5173.

### Render (Blueprint, no code changes needed)

`render.yaml` at the repo root defines the service: Docker runtime,
`/data` persistent disk, the locked-run env, and `META_API_KEY` as a
dashboard-entered secret (`sync: false` — never stored in git).

1. Push this branch so Render can see `render.yaml`.
2. Render dashboard → **New +** → **Blueprint** → select the repo.
3. Confirm the plan (persistent disks need a paid instance type),
   enter `META_API_KEY` when prompted (optional), **Apply**.
4. When the deploy is live, open the `*.onrender.com` URL: the form is
   pre-filled, and the seeded run is listed under it.

Render injects `PORT`; the web layer already honors it (verified
locally with `PORT=10000`). `render.yaml` tracks `main`, so deploy
after this work is merged.

Optional LLM features (claims, phraser, planner): pass your key to the
container environment (`META_API_KEY` in the compose environment). The
key stays server-side; the per-run call cap still applies. Without it,
the deterministic core works and LLM stages honestly report NO-LLM.

## Verify the hosted flow

```sh
curl -s -X POST http://127.0.0.1:5173/api/analyze \
  -H 'content-type: application/json' \
  -d '{"repoPath":"/ignored","baseRef":"x","headRef":"y","scenariosDir":"/ignored"}'
# -> {"runId":"..."} — note the ignored values still run the locked subject
```

Then open `http://127.0.0.1:5173`, press Analyze, lock a prediction
(`route:GET /definitely-missing` reproduces the recorded gate), and read
the report. Expected: `GET /definitely-missing` CONFIRMED, exercised
reads CLEARED, write-method patterns UNVERIFIED.

## Limits (state them on the page/README, don't hide them)

- One fixed subject and commit pair; not a general review service.
- No accounts; anyone with the link can start runs (each replays the
  subject twice — budget CPU accordingly; the built-in limits above
  apply, and you can add proxy limits on top).
- Live agent Q&A uses the server's local `muse` binary; in the
  container there is none, so Ask honestly degrades — receipts record
  `agentMode: not_asked` unless a session is wired.
- Runs and keys persist only in the `rw-data` volume; `docker compose
  down -v` resets them.
