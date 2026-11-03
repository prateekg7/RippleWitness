import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProcRegistry, discoverStartCommand, ensureDeps, pickFreePort, pnpmLauncher } from "@ripplewitness/replay";
import type { FusedNode } from "@ripplewitness/core";
import type { AdoptCandidate } from "./adopt.js";

/** F-15 auto-loop queue: UNVERIFIED routes the static pass says are impacted. Pure. */
export function unverifiedQueue(fused: FusedNode[]): string[] {
  return fused
    .filter((n) => n.status === "UNVERIFIED" && n.staticImpacted && n.routeId.startsWith("route:"))
    .map((n) => n.routeId)
    .sort();
}

/**
 * Template candidates for queued routes (F-15): minimal method+path calls.
 * Parameterized paths (`:id`) are skipped, never guessed — the endpoint
 * reports them so a human can supply values as scenario variables.
 */
export function synthesizeTemplates(routeIds: string[]): { candidates: AdoptCandidate[]; skipped: { routeId: string; reason: string }[] } {
  const candidates: AdoptCandidate[] = [];
  const skipped: { routeId: string; reason: string }[] = [];
  for (const rid of routeIds) {
    const m = /^route:([A-Z]+) (\S+)$/.exec(rid);
    if (!m) {
      skipped.push({ routeId: rid, reason: "not an http route id" });
      continue;
    }
    const method = m[1] as string;
    const path = m[2] as string;
    if (path.includes(":")) {
      skipped.push({ routeId: rid, reason: "parameterized path needs human-supplied values" });
      continue;
    }
    const withBody = method === "POST" || method === "PUT" || method === "PATCH";
    const slug = `${method.toLowerCase()}${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "-root"}`;
    candidates.push({
      id: `forge-auto-${slug}`,
      group: "forged",
      method,
      path,
      headers: withBody ? { "content-type": "application/json" } : {},
      body: withBody ? {} : null,
      source: `template:${rid}`,
    });
  }
  return { candidates, skipped };
}

const OpenApiDoc = z.object({
  paths: z.record(
    z.record(
      z.object({
        parameters: z
          .array(
            z.object({
              name: z.string(),
              in: z.string().optional(),
              required: z.boolean().optional(),
              example: z.unknown().optional(),
              schema: z
                .object({ type: z.string().optional(), default: z.unknown().optional(), example: z.unknown().optional() })
                .passthrough()
                .optional(),
            }),
          )
          .optional(),
        requestBody: z
          .object({ content: z.record(z.object({ schema: z.unknown().optional() }).passthrough()).optional() })
          .passthrough()
          .optional(),
      }).passthrough(),
    ),
  ),
});

const OPENAPI_METHODS = ["get", "post", "put", "patch", "delete"];

function placeholder(schema: unknown, depth: number): unknown {
  if (depth > 2 || typeof schema !== "object" || schema === null) return "x";
  const s = schema as { example?: unknown; default?: unknown; type?: string; properties?: Record<string, unknown>; items?: unknown };
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  switch (s.type) {
    case "integer":
      return 1;
    case "number":
      return 1.0;
    case "boolean":
      return true;
    case "array":
      // Empty arrays: minimal valid bodies are likelier to execute; the
      // execution gate (not the guess) decides whether to keep the scenario.
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = placeholder(v, depth + 1);
      return out;
    }
    default:
      return "x";
  }
}

/**
 * Synthesize candidate scenarios from an OpenAPI document (F-19). Pure:
 * placeholders come from examples/defaults, else minimal typed values.
 * Candidates are unverified here — adoption execution-keeps them.
 */
export function synthesizeFromOpenApi(doc: unknown): AdoptCandidate[] {
  const parsed = OpenApiDoc.safeParse(doc);
  if (!parsed.success) return [];
  const out: AdoptCandidate[] = [];
  for (const [rawPath, ops] of Object.entries(parsed.data.paths).sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const [method, op] of Object.entries(ops).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!OPENAPI_METHODS.includes(method)) continue;
      let path = rawPath;
      const query: [string, string][] = [];
      for (const p of op.parameters ?? []) {
        const value = String(p.example ?? p.schema?.example ?? p.schema?.default ?? "1");
        if (p.in === "query") {
          if (p.required) query.push([p.name, value]);
        } else if (p.in === "path" || p.in === undefined) {
          path = path.replace(`{${p.name}}`, value);
        }
      }
      // Unfilled template leftovers get the neutral placeholder.
      path = path.replace(/\{[^}]+\}/g, "1");
      if (query.length > 0) path += `?${query.map(([k, v]) => `${k}=${v}`).join("&")}`;
      const jsonSchema = op.requestBody?.content?.["application/json"]?.schema;
      const body = jsonSchema === undefined ? undefined : placeholder(jsonSchema, 0);
      const slug = `${method}-${rawPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root"}`;
      out.push({
        id: `forge-${slug}`,
        group: "forged",
        method: method.toUpperCase(),
        path,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body ?? null,
        source: `openapi:${method.toUpperCase()} ${rawPath}`,
      });
    }
  }
  return out;
}

export interface ForgeBoot {
  worktreeAppDir: string;
  sourceAppDir: string;
  language: "node" | "python";
  appStart?: string[];
  seedDb?: string;
  timeoutMs?: number;
}

/**
 * Boot one side from a worktree and fetch its `/openapi.json` (F-19). The doc
 * is static content, so no determinism interposition is applied. Never throws.
 */
export async function fetchOpenApiDoc(
  boot: ForgeBoot,
): Promise<{ ok: true; doc: unknown } | { ok: false; error: string }> {
  try {
    await ensureDeps(boot.sourceAppDir, boot.worktreeAppDir, "forge", "forge", { language: boot.language });
    const appStart =
      boot.appStart ??
      (boot.language === "node" ? discoverStartCommand(boot.worktreeAppDir) : null) ??
      (boot.language === "python" ? null : [...pnpmLauncher(), "start"]);
    if (!appStart) return { ok: false, error: "python subjects require an explicit appStart command" };
    const port = await pickFreePort();
    const dir = mkdtempSync(join(tmpdir(), "rw-forge-"));
    const dbPath = join(dir, "forge.sqlite");
    if (boot.seedDb && existsSync(boot.seedDb)) copyFileSync(boot.seedDb, dbPath);
    const [cmd, ...args] = appStart as [string, ...string[]];
    const procs = new ProcRegistry();
    const child = procs.spawn(cmd, args, boot.worktreeAppDir, {
      PATH: process.env.PATH as string,
      PORT: String(port),
      DB_PATH: dbPath,
      SEED: "42",
      FROZEN_TIME: "2026-01-01T00:00:00Z",
      EXTERNAL_MODE: "mock",
      OUTBOUND_LOG: join(dir, "out.log"),
    }, { captureStderr: true });
    try {
      const deadline = Date.now() + (boot.timeoutMs ?? 15000);
      for (;;) {
        if (child.exitCode !== null) {
          const tail = procs.stderrTail(child).trim().replace(/\s+/g, " ").slice(-500);
          return { ok: false, error: `app exited before serving /openapi.json${tail ? ` — app stderr: ${tail}` : ""}` };
        }
        try {
          const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (h.ok) break;
        } catch {
          // Not up yet.
        }
        if (Date.now() > deadline) return { ok: false, error: "health check timed out" };
        await new Promise((r) => setTimeout(r, 250));
      }
      const res = await fetch(`http://127.0.0.1:${port}/openapi.json`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { ok: false, error: `GET /openapi.json -> ${res.status}` };
      return { ok: true, doc: (await res.json()) as unknown };
    } finally {
      await procs.killAll();
    }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) };
  }
}
