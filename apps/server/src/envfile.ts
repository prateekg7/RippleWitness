import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Minimal .env loader for local runs. The server is normally started from
 * apps/server via pnpm filters, while the user's .env lives at the repo
 * root, so we search upward from the working directory. Existing non-blank
 * process env always wins; blank placeholders are treated as unset.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
        if (first === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
    }
    out[m[1] as string] = value;
  }
  return out;
}

export function findDotEnv(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadDotEnv(
  startDir = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  const path = findDotEnv(startDir);
  if (!path) return null;
  let parsed: Record<string, string>;
  try {
    parsed = parseDotEnv(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  for (const [key, value] of Object.entries(parsed)) {
    const current = env[key];
    if (current === undefined || current.trim() === "") env[key] = value;
  }
  return path;
}
