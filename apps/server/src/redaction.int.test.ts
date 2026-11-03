import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "./app.js";
import { openStore, putArtifact } from "./store.js";

/**
 * Anti-anchoring redaction invariant (E2E-02, API level): before lock, no
 * response may carry observed data. The browser suite re-checks this over
 * the wire with the real UI driving.
 */
describe("pre-lock redaction (E2E-02)", () => {
  it("map hides observed fields; reveal/questions/ablate/fn-run 423", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-red-"));
    const db = openStore(join(dir, "runs.db"));
    db.prepare("INSERT INTO runs (id, repoPath, baseRef, headRef, status, stages, locked, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "r1",
      "/repo",
      "b",
      "h",
      "ready",
      "{}",
      0,
      new Date().toISOString(),
    );
    putArtifact(db, "r1", "fused", [
      { routeId: "route:GET /s", status: "SURPRISE", exercised: true, observedChanged: true, staticImpacted: false, inDiff: false, surprise: true, contradictedBy: [] },
    ]);
    const app = createServer(db, { workRoot: join(dir, "wt"), home: dir });
    const map = await request(app).get("/api/runs/r1/map");
    expect(map.status).toBe(200);
    const body = JSON.stringify(map.body);
    expect(body).not.toContain("SURPRISE");
    expect(body).not.toContain("observedChanged");
    expect(body).not.toContain("surprise");
    expect(map.body.nodes[0]).toEqual({ routeId: "route:GET /s", staticImpacted: false, inDiff: false, exercised: true });
    for (const [method, url] of [
      ["get", "/api/runs/r1/reveal"],
      ["get", "/api/runs/r1/questions"],
      ["post", "/api/runs/r1/agent-message"],
      ["post", "/api/runs/r1/ablate"],
      ["post", "/api/runs/r1/fn-run"],
      ["post", "/api/runs/r1/forge/auto"],
    ] as const) {
      const r = method === "get" ? await request(app).get(url) : await request(app).post(url).send({});
      expect(r.status, url).toBe(423);
    }
  });
});
