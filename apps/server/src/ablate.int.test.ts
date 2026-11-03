import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import { openStore, putArtifact } from "./store.js";

const exec = promisify(execFile);

const SERVER_JS = `import http from "node:http";
import { value } from "./helper.js";
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  if (req.url === "/value" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ v: value() })); return;
  }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`;

async function tinyRepo(): Promise<{ repoPath: string; base: string; head: string; scenariosDir: string }> {
  const repoPath = mkdtempSync(join(tmpdir(), "rw-abl-"));
  await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
  await exec("git", ["config", "user.email", "t@l"], { cwd: repoPath });
  await exec("git", ["config", "user.name", "t"], { cwd: repoPath });
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(repoPath, "node_modules"));
  writeFileSync(join(repoPath, "server.js"), SERVER_JS);
  writeFileSync(join(repoPath, "helper.js"), `export function value() { return "base"; }\n`);
  writeFileSync(join(repoPath, "note.txt"), "a\n");
  writeFileSync(join(repoPath, "seed.db"), "");
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["commit", "-qm", "base"], { cwd: repoPath });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  writeFileSync(join(repoPath, "helper.js"), `export function value() { return "head"; }\n`);
  writeFileSync(join(repoPath, "note.txt"), "b\n");
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["commit", "-qm", "head"], { cwd: repoPath });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  const scenariosDir = mkdtempSync(join(tmpdir(), "rw-abl-scen-"));
  writeFileSync(
    join(scenariosDir, "s1.json"),
    JSON.stringify({ id: "s1", group: "g", routeIds: ["route:GET /value"], steps: [{ method: "GET", path: "/value" }] }),
  );
  return { repoPath, base, head, scenariosDir };
}

async function setup() {
  const t = await tinyRepo();
  const dir = mkdtempSync(join(tmpdir(), "rw-abl-db-"));
  const db = openStore(join(dir, "runs.db"));
  db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "r1",
    t.repoPath,
    t.base,
    t.head,
    "ready",
    "{}",
    1,
    new Date().toISOString(),
  );
  putArtifact(db, "r1", "inputs", {
    repoPath: t.repoPath,
    baseRef: t.base,
    headRef: t.head,
    scenariosDir: t.scenariosDir,
    appDir: ".",
    seedDbRel: "seed.db",
    appStart: ["node", "server.js"],
    language: "node",
  });
  putArtifact(db, "r1", "fused", [
    {
      routeId: "route:GET /value",
      status: "CONFIRMED",
      exercised: true,
      observedChanged: true,
      staticImpacted: true,
      inDiff: false,
      surprise: false,
      contradictedBy: [],
    },
  ]);
  putArtifact(db, "r1", "impactPaths", { "route:GET /value": ["fn:value"] });
  putArtifact(db, "r1", "graph", { nodes: [{ id: "fn:value", kind: "service", label: "value", file: "helper.js" }], edges: [] });
  return { app: createServer(db, { workRoot: join(dir, "wt"), home: dir }), ...t };
}

describe("causal ablation F-16 (CT-ABL-02)", () => {
  it("plans pin candidates from the impact path", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/runs/r1/ablations").query({ routeId: "route:GET /value" });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([{ kind: "pin_file", file: "helper.js", reason: "changed file on the static impact path" }]);
  });

  it("confirms the true coupling and contests the wrong one", async () => {
    const { app } = await setup();
    const good = await request(app)
      .post("/api/runs/r1/ablate")
      .send({ routeId: "route:GET /value", kind: "pin_file", file: "helper.js" });
    expect(good.status).toBe(200);
    expect(good.body.verdict).toBe("CAUSALLY-CONFIRMED");
    expect(good.body.changedAfter).toBe(false);
    const bad = await request(app)
      .post("/api/runs/r1/ablate")
      .send({ routeId: "route:GET /value", kind: "pin_file", file: "note.txt" });
    expect(bad.status).toBe(200);
    expect(bad.body.verdict).toBe("CONTESTED");
    expect(bad.body.changedAfter).toBe(true);
  }, 120000);
});
