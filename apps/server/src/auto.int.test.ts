import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import { getArtifact, openStore, putArtifact } from "./store.js";

const exec = promisify(execFile);

const SERVER_JS = `import http from "node:http";
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/health") return json({});
  if (req.url === "/value" && req.method === "GET") return json({ v: 1 });
  if (req.url === "/other" && req.method === "GET") return json({ w: "same" });
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`;

describe("forge auto-loop F-15 (CT-F15-02)", () => {
  it("exercises the UNVERIFIED queue with templates and re-fuses", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "rw-auto-"));
    await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
    await exec("git", ["config", "user.email", "t@l"], { cwd: repoPath });
    await exec("git", ["config", "user.name", "t"], { cwd: repoPath });
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(repoPath, "node_modules"));
    writeFileSync(join(repoPath, "server.js"), SERVER_JS);
    writeFileSync(join(repoPath, "seed.db"), "");
    await exec("git", ["add", "-A"], { cwd: repoPath });
    await exec("git", ["commit", "-qm", "base"], { cwd: repoPath });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "head"], { cwd: repoPath });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    const scenariosDir = mkdtempSync(join(tmpdir(), "rw-auto-scen-"));
    writeFileSync(
      join(scenariosDir, "s1.json"),
      JSON.stringify({ id: "s1", group: "g", routeIds: ["route:GET /value"], steps: [{ method: "GET", path: "/value" }] }),
    );
    const dir = mkdtempSync(join(tmpdir(), "rw-auto-db-"));
    const db = openStore(join(dir, "runs.db"));
    db.prepare(
      "INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, prediction, score, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "r1",
      repoPath,
      base,
      head,
      "ready",
      "{}",
      1,
      JSON.stringify({ routeIds: [], nothingElse: false }),
      JSON.stringify({ predicted: [], observed: [], hits: [], misses: [], falsePositives: [], recall: 1, precision: 1, passed: true, passReason: "x" }),
      new Date().toISOString(),
    );
    putArtifact(db, "r1", "inputs", {
      repoPath,
      baseRef: base,
      headRef: head,
      scenariosDir,
      appDir: ".",
      seedDbRel: "seed.db",
      appStart: ["node", "server.js"],
      language: "node",
    });
    putArtifact(db, "r1", "fused", [
      { routeId: "route:GET /other", status: "UNVERIFIED", exercised: false, observedChanged: false, staticImpacted: true, inDiff: false, surprise: false, contradictedBy: [] },
      { routeId: "route:GET /value", status: "CLEARED", exercised: true, observedChanged: false, staticImpacted: true, inDiff: false, surprise: false, contradictedBy: [] },
    ]);
    putArtifact(db, "r1", "routeDiffs", [
      { routeId: "route:GET /value", scenarioIds: ["s1"], changed: false, kinds: [], diffs: [], tolerated: [] },
    ]);
    const app = createServer(db, { workRoot: join(dir, "wt"), home: dir });
    const res = await request(app).post("/api/runs/r1/forge/auto");
    expect(res.status).toBe(200);
    expect(res.body.queued).toEqual(["route:GET /other"]);
    expect(res.body.synthesized).toBe(1);
    expect(res.body.kept).toHaveLength(1);
    const fused = getArtifact<{ routeId: string; exercised: boolean; status: string }[]>(db, "r1", "fused") ?? [];
    const other = fused.find((n) => n.routeId === "route:GET /other");
    expect(other?.exercised).toBe(true);
    expect(other?.status).not.toBe("UNVERIFIED");
  }, 180000);
});
