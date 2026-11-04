import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import { getArtifact, openStore } from "./store.js";

/** Analyses run fire-and-forget; never close the store under them (CI timing). */
async function settle(db: ReturnType<typeof openStore>): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    const row = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status = 'running'").get() as { c: number };
    if (row.c === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("locked hosted run", () => {
  it("forces locked subject fields regardless of the request body", async () => {
    const db = openStore(join(mkdtempSync(join(tmpdir(), "rw-locked-")), "runs.db"));
    const app = createServer(db, {
      workRoot: mkdtempSync(join(tmpdir(), "rw-locked-wt-")),
      home: mkdtempSync(join(tmpdir(), "rw-locked-home-")),
      lockedRun: { repoPath: "/locked/repo", baseRef: "rw-base", headRef: "rw-head", scenariosDir: "/locked/scenarios" },
    });
    const config = await request(app).get("/api/config");
    expect(config.status).toBe(200);
    expect((config.body as { lockedRun: { repoPath: string } }).lockedRun.repoPath).toBe("/locked/repo");
    expect((config.body as { capabilities: { llm: boolean; agentSession: string } }).capabilities).toEqual({
      llm: false,
      agentSession: "stub",
    });
    const started = await request(app)
      .post("/api/analyze")
      .send({ repoPath: "/elsewhere", baseRef: "x", headRef: "y", scenariosDir: "/elsewhere/scenarios" });
    expect(started.status).toBe(202);
    const runId = (started.body as { runId: string }).runId;
    let inputs: { repoPath?: string; baseRef?: string; headRef?: string } | null = null;
    for (let i = 0; i < 50 && !inputs; i += 1) {
      inputs = getArtifact<{ repoPath?: string; baseRef?: string; headRef?: string }>(db, runId, "inputs");
      if (!inputs) await new Promise((r) => setTimeout(r, 100));
    }
    expect(inputs?.repoPath).toBe("/locked/repo");
    expect(inputs?.baseRef).toBe("rw-base");
    expect(inputs?.headRef).toBe("rw-head");
    await settle(db);
    db.close();
  });

  it("rate-limits analyze posts in locked mode", async () => {
    const db = openStore(join(mkdtempSync(join(tmpdir(), "rw-locked-")), "runs.db"));
    const app = createServer(db, {
      workRoot: mkdtempSync(join(tmpdir(), "rw-locked-wt-")),
      home: mkdtempSync(join(tmpdir(), "rw-locked-home-")),
      lockedRun: { repoPath: "/locked/repo", baseRef: "rw-base", headRef: "rw-head", scenariosDir: "/locked/scenarios" },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await request(app)
        .post("/api/analyze")
        .send({ repoPath: "/x", baseRef: "a", headRef: "b", scenariosDir: "/s" });
      statuses.push(r.status);
      // Let each doomed analysis settle so the concurrency cap (2) cannot
      // mask the hourly counter this test measures.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    expect(statuses.slice(0, 6)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(statuses[6]).toBe(429);
    await settle(db);
    db.close();
  });
});
