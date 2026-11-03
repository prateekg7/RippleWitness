import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MockSession } from "@ripplewitness/agents";
import type { AgentSessionPort } from "@ripplewitness/agents";
import { createServer } from "./app.js";
import { openStore, putArtifact } from "./store.js";

const exec = promisify(execFile);

class DirtySession implements AgentSessionPort {
  constructor(private readonly repo: string) {}
  async ask(): Promise<{ text: string; mode: "live_session" }> {
    writeFileSync(join(this.repo, "qna-pwned.txt"), "written during ask\n");
    return { text: "not verified", mode: "live_session" };
  }
}

async function setup(session: AgentSessionPort) {
  const repo = mkdtempSync(join(tmpdir(), "rw-qa-"));
  await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
  await exec("git", ["config", "user.email", "t@l"], { cwd: repo });
  await exec("git", ["config", "user.name", "t"], { cwd: repo });
  await exec("git", ["commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
  const dir = mkdtempSync(join(tmpdir(), "rw-qa-db-"));
  const db = openStore(join(dir, "runs.db"));
  db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "r1",
    repo,
    "b",
    "h",
    "ready",
    "{}",
    1,
    new Date().toISOString(),
  );
  putArtifact(db, "r1", "inputs", { repoPath: repo });
  putArtifact(db, "r1", "questionTexts", { "SURPRISE::": { text: "why?", anchors: ["a"] } });
  db.prepare("INSERT INTO questions (id, runId, template, routeId, claimId, status, askedCount, need) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "q1",
    "r1",
    "SURPRISE",
    null,
    null,
    "OPEN",
    0,
    1,
  );
  return { app: createServer(db, { workRoot: join(dir, "wt"), home: dir, session }), repo };
}

describe("Q&A read-only enforcement (SEC-07)", () => {
  it("accepts clean answers, refuses dirty ones", async () => {
    const clean = await setup(new MockSession(["not verified"]));
    const okRes = await request(clean.app).post("/api/runs/r1/questions/q1/ask");
    expect(okRes.status).toBe(200);
    expect(okRes.body.status).toBe("ASKED");

    const repo = mkdtempSync(join(tmpdir(), "rw-qa2-"));
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
    await exec("git", ["config", "user.email", "t@l"], { cwd: repo });
    await exec("git", ["config", "user.name", "t"], { cwd: repo });
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
    const dir = mkdtempSync(join(tmpdir(), "rw-qa2-db-"));
    const db = openStore(join(dir, "runs.db"));
    db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "r1",
      repo,
      "b",
      "h",
      "ready",
      "{}",
      1,
      new Date().toISOString(),
    );
    putArtifact(db, "r1", "inputs", { repoPath: repo });
    putArtifact(db, "r1", "questionTexts", { "SURPRISE::": { text: "why?", anchors: ["a"] } });
    db.prepare("INSERT INTO questions (id, runId, template, routeId, claimId, status, askedCount, need) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "q1",
      "r1",
      "SURPRISE",
      null,
      null,
      "OPEN",
      0,
      1,
    );
    const app = createServer(db, { workRoot: join(dir, "wt"), home: dir, session: new DirtySession(repo) });
    const bad = await request(app).post("/api/runs/r1/questions/q1/ask");
    expect(bad.status).toBe(503);
    expect(bad.body.error).toBe("qna_modified_tree");
  });
});
