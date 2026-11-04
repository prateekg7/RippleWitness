# RippleWitness hosted demo (single subject: typicode/json-server run).
# Build: docker build -t ripplewitness-hosted .
# Run with docker compose (see docker-compose.yml) or docs/HOSTING.md.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/canary/package.json packages/canary/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/crossexam/package.json packages/crossexam/package.json
COPY packages/graph/package.json packages/graph/package.json
COPY packages/receipt/package.json packages/receipt/package.json
COPY packages/replay/package.json packages/replay/package.json
COPY eval/package.json eval/package.json
RUN corepack pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN corepack pnpm --filter @ripplewitness/web run build

FROM build AS runtime
ENV NODE_ENV=production
# HF Spaces expects the app on 7860; Render injects PORT, compose pins 5173.
ENV PORT=7860
ENV RIPPLEWITNESS_HOME=/data
ENV HOSTED_SUBJECT_DIR=/subject/json-server
# This image is the judge demo: default to the prepared json-server subject
# so a manual Docker deploy cannot fall back to asking for local directories.
ENV RIPPLEWITNESS_LOCKED_RUN="{\"repoPath\":\"/subject/json-server\",\"baseRef\":\"rw-base\",\"headRef\":\"rw-head\",\"scenariosDir\":\"/app/docs/real-repo/scenarios\",\"seedDbRel\":\"seed/seed.db\",\"appStart\":[\"node\",\"--experimental-strip-types\",\"src/bin.ts\",\"rw-db.json\"]}"
RUN node scripts/prepare-hosted.mjs /subject/json-server
EXPOSE 5173
CMD ["sh", "-c", "corepack pnpm --filter @ripplewitness/server exec tsx src/cli.ts serve & corepack pnpm --filter @ripplewitness/web exec vite preview --port ${PORT:-5173} --host 0.0.0.0; wait"]
