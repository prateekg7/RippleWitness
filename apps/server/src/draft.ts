import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Scenario Drafter (AGENTS.md B7, dev-time only): draft scenario JSON
 * skeletons from a route inventory. Output is reviewed and committed by a
 * human; it never runs at review time. Pure apart from the file writes.
 */
export function draftScenarios(routeIds: string[], group = "drafted"): { file: string; body: unknown }[] {
  return routeIds.map((rid, i) => {
    const m = /^route:([A-Z]+) (\S+)$/.exec(rid);
    const method = m?.[1] ?? "GET";
    const path = m?.[2] ?? "/";
    const withBody = method === "POST" || method === "PUT" || method === "PATCH";
    return {
      file: `draft-${String(i + 1).padStart(2, "0")}.json`,
      body: {
        id: `draft-${i + 1}`,
        group,
        routeIds: [rid],
        steps: [
          {
            method,
            path,
            ...(withBody ? { headers: { "content-type": "application/json" }, body: {} } : {}),
          },
        ],
        _todo: "human: fill path params, auth headers, and expected captures; then move out of drafts",
      },
    };
  });
}

/** Write drafts to outDir. Returns written file paths. Never throws. */
export function runDraft(routeIds: string[], outDir: string): { ok: true; files: string[] } | { ok: false; error: string } {
  if (routeIds.length === 0) return { ok: false, error: "no routes given" };
  try {
    mkdirSync(outDir, { recursive: true });
    const files: string[] = [];
    for (const d of draftScenarios(routeIds)) {
      const p = join(outDir, d.file);
      writeFileSync(p, `${JSON.stringify(d.body, null, 2)}\n`);
      files.push(p);
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
