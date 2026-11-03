import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runComputeSide } from "./runner.js";

describe("compute side env isolation", () => {
  it("subject functions cannot read server secrets from the environment", async () => {
    const wt = mkdtempSync(join(tmpdir(), "rw-compute-env-"));
    writeFileSync(
      join(wt, "probe.py"),
      "import os\n\ndef probe():\n    return os.environ.get('RW_LEAK_PROBE')\n",
    );
    process.env.RW_LEAK_PROBE = "must-not-leak";
    try {
      const out = await runComputeSide(
        wt,
        [{ id: "env-probe", group: "g", routeIds: ["fn:probe:probe"], kind: "compute", target: "probe:probe", args: [] }],
        { workRoot: wt, side: "base", seedDb: join(wt, "missing.db"), stepTimeoutMs: 30000, runtime: "python" },
      );
      expect(out.steps).toHaveLength(1);
      // The probe ran (200) and saw no inherited secret.
      expect(out.steps[0]?.status).toBe(200);
      expect(out.steps[0]?.body).toBeNull();
    } finally {
      delete process.env.RW_LEAK_PROBE;
    }
  });
});
