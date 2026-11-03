import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import { openStore, putArtifact } from "./store.js";

function setup(locked: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "rw-guard-"));
  const db = openStore(join(dir, "runs.db"));
  db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "r1",
    "/repo",
    "b",
    "h",
    "ready",
    "{}",
    locked ? 1 : 0,
    new Date().toISOString(),
  );
  putArtifact(db, "r1", "fused", []);
  const app = createServer(db, { workRoot: join(dir, "wt"), home: dir });
  return { app, db };
}

describe("gate scoring causes (predict wiring)", () => {
  it("miss causes use the stored impact paths (db coupling is not implicit_contract)", async () => {
    const { app, db } = setup(false);
    putArtifact(db, "r1", "fused", [
      { routeId: "route:GET /reports", status: "SURPRISE", exercised: true, observedChanged: true, staticImpacted: true, inDiff: false, isNew: false, surprise: false, contradictedBy: [] },
      { routeId: "route:GET /hidden", status: "SURPRISE", exercised: true, observedChanged: true, staticImpacted: false, inDiff: false, isNew: false, surprise: true, contradictedBy: [] },
    ]);
    putArtifact(db, "r1", "impactPaths", {
      "route:GET /reports": ["route:GET /reports", "shared:db:sales"],
      "route:GET /hidden": [],
    });
    const res = await request(app).post("/api/runs/r1/predict").send({ routeIds: [], nothingElse: false });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT score FROM runs WHERE id = ?").get("r1") as { score: string };
    const score = JSON.parse(row.score) as { misses: { routeId: string; cause: string }[] };
    const byRoute = new Map(score.misses.map((m) => [m.routeId, m.cause]));
    expect(byRoute.get("route:GET /reports")).toBe("missed_db_coupling");
    expect(byRoute.get("route:GET /hidden")).toBe("implicit_contract");
  });
});

describe("predict + traversal guards (IT-API-01, SEC-04)", () => {
  it("identical relock is idempotent; different payload 409s", async () => {
    const { app, db } = setup(false);
    const first = await request(app).post("/api/runs/r1/predict").send({ routeIds: ["route:GET /a"], nothingElse: false });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ locked: true });
    const dup = await request(app).post("/api/runs/r1/predict").send({ routeIds: ["route:GET /a"], nothingElse: false });
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ locked: true, duplicate: true });
    const other = await request(app).post("/api/runs/r1/predict").send({ routeIds: [], nothingElse: true });
    expect(other.status).toBe(409);
    // Calibration recorded once, not per relock.
    const n = (db.prepare("SELECT COUNT(*) AS n FROM calibration").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("reveal includes questions from the store", async () => {
    const { app, db } = setup(false);
    db.prepare("INSERT INTO questions (id, runId, template, routeId, claimId, status, askedCount, need) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "q1",
      "r1",
      "SURPRISE_RIPPLE",
      "route:GET /a",
      null,
      "OPEN",
      0,
      3,
    );
    putArtifact(db, "r1", "questionTexts", { "SURPRISE_RIPPLE:route:GET /a:": { text: "Why did /a change?", anchors: ["a1"] } });
    await request(app).post("/api/runs/r1/predict").send({ routeIds: [], nothingElse: false });
    const reveal = await request(app).get("/api/runs/r1/reveal");
    expect(reveal.status).toBe(200);
    expect(reveal.body.questions).toHaveLength(1);
    expect(reveal.body.questions[0]).toMatchObject({ id: "q1", template: "SURPRISE_RIPPLE", text: "Why did /a change?" });
  });

  it("rejects .. file params with 400", async () => {
    const { app } = setup(true);
    const ablate = await request(app).post("/api/runs/r1/ablate").send({ routeId: "route:GET /a", kind: "pin_file", file: "../x.js" });
    expect(ablate.status).toBe(400);
    const fnrun = await request(app).post("/api/runs/r1/fn-run").send({ fn: "../x.js#f" });
    expect(fnrun.status).toBe(400);
    const canary = await request(app).post("/api/runs/r1/canary").send({ file: "a/../../x.ts" });
    expect(canary.status).toBe(400);
  });
});
