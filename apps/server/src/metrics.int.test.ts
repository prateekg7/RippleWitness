import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { clearRunClients } from "@ripplewitness/agents";
import { createServer } from "./app.js";
import { openStore } from "./store.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rw-metrics-"));
  const db = openStore(join(dir, "runs.db"));
  db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "r1",
    "/repo",
    "b",
    "h",
    "ready",
    "{}",
    new Date().toISOString(),
  );
  const app = createServer(db, { workRoot: join(dir, "wt"), home: dir });
  return app;
}

describe("agent metrics endpoint (CT-AGE-04)", () => {
  afterEach(() => {
    clearRunClients();
  });

  it("404s for unknown runs", async () => {
    const res = await request(setup()).get("/api/runs/nope/metrics");
    expect(res.status).toBe(404);
  });

  it("503s without an LLM key", async () => {
    const prev = process.env.META_API_KEY;
    delete process.env.META_API_KEY;
    try {
      const res = await request(setup()).get("/api/runs/r1/metrics");
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("no_llm");
    } finally {
      if (prev !== undefined) process.env.META_API_KEY = prev;
    }
  });

  it("returns zeroed metrics for a fresh run with a key", async () => {
    const prev = process.env.META_API_KEY;
    process.env.META_API_KEY = "test-key";
    try {
      const res = await request(setup()).get("/api/runs/r1/metrics");
      expect(res.status).toBe(200);
      expect(res.body.metrics.calls).toBe(0);
      expect(res.body.metrics.perAgent).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = prev;
    }
  });
});
