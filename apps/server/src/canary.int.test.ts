import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import type { ServerOptions } from "./app.js";
import { openStore, putArtifact } from "./store.js";

const exec = promisify(execFile);

async function setup(planner?: ServerOptions["planner"]) {
  const repo = mkdtempSync(join(tmpdir(), "rw-plan-"));
  await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
  await exec("git", ["config", "user.email", "t@l"], { cwd: repo });
  await exec("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "base"], { cwd: repo });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  writeFileSync(join(repo, "a.ts"), "export const x = 2;\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-qm", "head"], { cwd: repo });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "rw-plan-db-"));
  const db = openStore(join(dir, "runs.db"));
  db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "r1",
    repo,
    base,
    head,
    "ready",
    "{}",
    1,
    new Date().toISOString(),
  );
  putArtifact(db, "r1", "inputs", { repoPath: repo, baseRef: base, headRef: head, scenariosDir: dir, appDir: "." });
  const app = createServer(db, { workRoot: join(dir, "wt"), home: dir, ...(planner ? { planner } : {}) });
  return app;
}

describe("canary planner wiring B6 (CT-PLN-02)", () => {
  it("503s with no planner, consults the stub planner otherwise", async () => {
    const bare = await setup();
    const none = await request(bare).post("/api/runs/r1/canary").send({});
    expect(none.status).toBe(503);

    const seen: { file: string; startLine: number; text: string }[][] = [];
    const app = await setup(async (hunks) => {
      seen.push(hunks);
      return { file: "missing.ts", line: 1, operator: "flip_cmp", rationale: "t" };
    });
    const res = await request(app).post("/api/runs/r1/canary").send({});
    expect(res.status).toBe(404); // plan consulted, then file lookup failed
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.file).toBe("a.ts");
  });

  it("rejects bad plans with 422", async () => {
    const app = await setup(async () => ({ file: "../x.ts", line: 1, operator: "flip_cmp", rationale: "t" }));
    const res = await request(app).post("/api/runs/r1/canary").send({});
    expect(res.status).toBe(422);
  });
});
