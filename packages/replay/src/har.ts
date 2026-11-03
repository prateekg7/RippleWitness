import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Recorded-traffic source (M-10): convert a HAR 1.2 capture into curated
 * scenario JSON that `loadScenarios` accepts. One scenario per entry; the
 * reviewer curates (and re-records deterministically) before relying on it.
 *
 * Security: Authorization/Cookie headers are always stripped — recorded
 * traffic must never smuggle credentials into the scenario suite.
 */

const HarEntrySchema = z.object({
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional().default([]),
    postData: z.object({ mimeType: z.string(), text: z.string().optional() }).optional(),
  }),
  response: z.object({ status: z.number() }).optional(),
});
const HarSchema = z.object({ log: z.object({ entries: z.array(HarEntrySchema) }) });

export interface HarScenarioStep {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface HarScenario {
  id: string;
  group: string;
  routeIds: string[];
  steps: HarScenarioStep[];
  source: string;
}

export interface HarImportOptions {
  /** Only import entries from this origin (e.g. "http://127.0.0.1:4401"). */
  baseUrl?: string;
  group?: string;
  idPrefix?: string;
  /** Import error responses too (default: skip status >= 400). */
  includeErrors?: boolean;
}

const STRIPPED_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authenticate", "proxy-authorization"]);

function slug(pathname: string): string {
  const s = pathname
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(0, 40);
  return s.length > 0 ? s : "root";
}

export function harToScenarios(har: unknown, opts: HarImportOptions = {}): HarScenario[] {
  const parsed = HarSchema.parse(har);
  const group = opts.group ?? "har";
  const prefix = opts.idPrefix ?? "har";
  const wantOrigin = opts.baseUrl ? new URL(opts.baseUrl).origin : null;
  const out: HarScenario[] = [];
  let n = 0;
  for (const entry of parsed.log.entries) {
    const status = entry.response?.status;
    if (!opts.includeErrors && typeof status === "number" && status >= 400) continue;
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      continue; // Not an absolute URL — not replayable traffic.
    }
    if (wantOrigin && url.origin !== wantOrigin) continue;
    const method = entry.request.method.toUpperCase();
    const path = url.pathname + url.search;
    const headers: Record<string, string> = {};
    for (const h of entry.request.headers) {
      if (STRIPPED_HEADERS.has(h.name.toLowerCase())) continue;
      if (h.name.toLowerCase() === "content-type") headers["content-type"] = h.value;
    }
    const step: HarScenarioStep = { method, path };
    if (Object.keys(headers).length > 0) step.headers = headers;
    const post = entry.request.postData;
    if (post?.text !== undefined) {
      if (post.mimeType.includes("json")) {
        try {
          step.body = JSON.parse(post.text) as unknown;
        } catch {
          step.body = post.text;
        }
      } else {
        step.body = post.text;
      }
    }
    n += 1;
    out.push({
      id: `${prefix}-${n}-${method.toLowerCase()}-${slug(url.pathname)}`,
      group,
      routeIds: [`route:${method} ${url.pathname}`],
      steps: [step],
      source: "har",
    });
  }
  return out;
}

export function writeHarScenarios(
  har: unknown,
  outDir: string,
  opts: HarImportOptions = {},
): { ok: true; files: string[] } | { ok: false; error: string } {
  let scenarios: HarScenario[];
  try {
    scenarios = harToScenarios(har, opts);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    mkdirSync(outDir, { recursive: true });
    const files: string[] = [];
    for (const s of scenarios) {
      const file = join(outDir, `${s.id}.json`);
      writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      files.push(file);
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
