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

No parameters to enter: subject repo, base ref (`rw-base`), head ref
(`rw-head`), scenarios dir, seed DB, and start command are pre-filled
and locked on the server.

1. Open the URL. Optionally open the **recorded run** listed under the
   form first.
2. Press **Analyze**, wait for `ready`.
3. On the Blast map, tick **Will change?** for each route they expect
   to behave differently, tick **Nothing else changes** if they believe
   only those routes change, then **Lock prediction**. (The recorded
   answer is `route:GET /definitely-missing`.)
4. Read the graded reveal (CONFIRMED/CLEARED/UNVERIFIED), open a
   question, and read the report with its
   `RippleWitness-Receipt:` trailer.

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

### Hugging Face Spaces (free, recommended for the demo link)

Spaces run a real Docker container on a public URL, no card required.
The repo already carries the Space metadata (README frontmatter:
`sdk: docker`, `app_port: 7860`; the image defaults `PORT=7860`).

1. Create a free account at huggingface.co.
2. **New Space** → name it e.g. `ripplewitness`, SDK **Docker**,
   template **Blank**, hardware **CPU basic (free)**, public.
3. Clone the empty Space repo, copy this checkout into it (excluding
   `.git`, `node_modules`, `.ripplewitness`), commit, push:

   ```sh
   git clone https://huggingface.co/spaces/<you>/ripplewitness hf-space
   rsync -a --exclude .git --exclude node_modules --exclude .ripplewitness ./ hf-space/
   cd hf-space && git add -A && git commit -m "RippleWitness demo" && git push
   ```

4. In the Space **Settings → Variables and secrets**, add:
   - Variable `RIPPLEWITNESS_LOCKED_RUN` = the JSON from
     `docker-compose.yml`.
   - Variable `RIPPLEWITNESS_HOME` = `/data`.
   - Secret `META_API_KEY` = your key (optional; stored encrypted,
     never printed or committed).
5. The Space builds the Dockerfile and serves at
   `https://huggingface.co/spaces/<you>/ripplewitness` (direct app:
   `https://<you>-ripplewitness.hf.space`). That's the judge URL.

Free-tier realities: the Space sleeps after ~48h idle and wakes in
about a minute on first visit; storage is ephemeral, so runs reset on
restart (the seeded run recreates itself on boot). Fine for a demo;
not a production service.

### Render (free tier, with or without Blueprint)

The paid part was never Blueprint — it was the persistent disk.
`render.yaml` now pins `plan: free` with no disk: state is ephemeral
(runs reset on restart; the seeded run recreates itself on boot) and
the service spins down after ~15 min idle (~1 min to wake).

Blueprint path:

1. Push `main` so Render can see `render.yaml`.
2. Render dashboard → **New +** → **Blueprint** → select the repo.
3. Enter `META_API_KEY` when prompted (optional), **Apply**.
4. Open the `*.onrender.com` URL.

Manual path (no Blueprint): **New +** → **Web Service** → connect the
repo → Runtime **Docker**, instance type **Free** → add the same env
vars by hand (`RIPPLEWITNESS_LOCKED_RUN` JSON from `docker-compose.yml`,
`RIPPLEWITNESS_HOME=/data`, optional `META_API_KEY`) → **Create**.

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
