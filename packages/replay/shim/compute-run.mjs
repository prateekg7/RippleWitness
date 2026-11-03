#!/usr/bin/env node
/**
 * Sandbox function runner for compute scenarios on node subjects (F-10/F-23).
 *
 * Usage: node compute-run.mjs <file#export> <args.json>
 * Imports the target relative to the current working directory (a subject
 * worktree), calls it with the JSON fixtures, and prints a result envelope:
 *   {"ok": true, "value": <json>} | {"ok": false, "error": "<type: message>"}
 * `.ts` targets are imported with type-stripping (Node >= 22.6); only
 * erasable syntax works — anything else fails inside the envelope.
 * kwargs are not supported (functions take positional args); a non-empty
 * kwargs object fails inside the envelope.
 */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function toJsonable(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonable);
  if (ArrayBuffer.isView(value)) {
    return { __tensor__: { shape: [value.length], dtype: value.constructor.name, values: [...value].map(Number) } };
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[String(k)] = toJsonable(v);
    return out;
  }
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return { __repr__: String(value).slice(0, 500), __type__: typeof value };
  }
}

function fail(error) {
  console.log(JSON.stringify({ ok: false, error: String(error).slice(0, 500) }));
}

async function main() {
  const [target, argsPath] = process.argv.slice(2);
  if (!target || !argsPath) {
    fail("usage: compute-run.mjs <file#export> <args.json>");
    return;
  }
  const m = /^([^#]+)#([A-Za-z_$][\w$]*)$/.exec(target);
  if (!m) {
    fail(`bad target (want file#export): ${target}`);
    return;
  }
  const root = `${resolve(process.cwd())}${sep}`;
  const file = resolve(process.cwd(), m[1]);
  if (!file.startsWith(root)) {
    fail(`target escapes worktree: ${target}`);
    return;
  }
  try {
    const call = JSON.parse(readFileSync(argsPath, "utf8"));
    const kwargs = call.kwargs ?? {};
    if (Object.keys(kwargs).length > 0) {
      fail("kwargs_unsupported: node targets take positional args only");
      return;
    }
    const mod = await import(pathToFileURL(file).href);
    const fn = mod[m[2]];
    if (typeof fn !== "function") {
      fail(`not a function export: ${target}`);
      return;
    }
    const value = await fn(...(call.args ?? []));
    console.log(JSON.stringify({ ok: true, value: toJsonable(value) }));
  } catch (e) {
    fail(`${e?.constructor?.name ?? "Error"}: ${e?.message ?? e}`);
  }
}

await main();
