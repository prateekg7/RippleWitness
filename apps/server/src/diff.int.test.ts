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

describe("diff endpoint F-01 (CT-F01-02)", () => {
  it("serves parsed hunks before lock", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rw-diff-"));
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
    await exec("git", ["config", "user.email", "t@l"], { cwd: repo });
    await exec("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "f.ts"), "a\nb\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "base"], { cwd: repo });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    writeFileSync(join(repo, "f.ts"), "a\nB\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "head"], { cwd: repo });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "rw-diff-db-"));
    const db = openStore(join(dir, "runs.db"));
    db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "r1",
      repo,
      base,
      head,
      "ready",
      "{}",
      0,
      new Date().toISOString(),
    );
    putArtifact(db, "r1", "inputs", { repoPath: repo, baseRef: base, headRef: head });
    const app = createServer(db, { workRoot: join(dir, "wt"), home: dir });
    const res = await request(app).get("/api/runs/r1/diff");
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].file).toBe("f.ts");
    expect(res.body.files[0].hunks[0].lines.map((l: { type: string }) => l.type)).toEqual(["context", "del", "add"]);
    expect((await request(app).get("/api/runs/nope/diff")).status).toBe(404);
  });
});
