import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import { openStore, putArtifact } from "./store.js";

const exec = promisify(execFile);

async function tinyPyRepo(): Promise<{ repoPath: string; base: string; head: string }> {
  const repoPath = mkdtempSync(join(tmpdir(), "rw-fnrun-"));
  await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
  await exec("git", ["config", "user.email", "t@l"], { cwd: repoPath });
  await exec("git", ["config", "user.name", "t"], { cwd: repoPath });
  writeFileSync(join(repoPath, "calc.py"), "def add(a, b):\n    return a + b\n");
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["commit", "-qm", "base"], { cwd: repoPath });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  writeFileSync(join(repoPath, "calc.py"), "def add(a, b):\n    return a + b + 1\n");
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["commit", "-qm", "head"], { cwd: repoPath });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  return { repoPath, base, head };
}

describe("fn-run endpoint F-10 (CT-FNR-04)", () => {
  it("grades predicted outputs against base and head execution", async () => {
    const { repoPath, base, head } = await tinyPyRepo();
    const dir = mkdtempSync(join(tmpdir(), "rw-fnrun-db-"));
    const db = openStore(join(dir, "runs.db"));
    db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "r1",
      repoPath,
      base,
      head,
      "ready",
      "{}",
      1,
      new Date().toISOString(),
    );
    putArtifact(db, "r1", "inputs", { repoPath, baseRef: base, headRef: head, appDir: "." });
    putArtifact(db, "r1", "language", { explicit: null, detected: "python", effective: "python" });
    const app = createServer(db, { workRoot: join(dir, "wt"), home: dir });
    const res = await request(app)
      .post("/api/runs/r1/fn-run")
      .send({ fn: "calc:add", args: [2, 3], predictedBase: 5, predictedHead: 5 });
    expect(res.status).toBe(200);
    expect(res.body.base).toEqual({ ok: true, value: 5 });
    expect(res.body.head).toEqual({ ok: true, value: 6 });
    expect(res.body.baseHit).toBe(true);
    expect(res.body.headHit).toBe(false);
    expect(res.body.changed).toBe(true);
  });

  it("requires a locked prediction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-fnrun-db-"));
    const db = openStore(join(dir, "runs.db"));
    db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "r2",
      "/x",
      "b",
      "h",
      "ready",
      "{}",
      0,
      new Date().toISOString(),
    );
    const app = createServer(db, { workRoot: join(dir, "wt"), home: dir });
    const res = await request(app).post("/api/runs/r2/fn-run").send({ fn: "calc:add" });
    expect(res.status).toBe(423);
  });
});
