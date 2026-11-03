import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-hash response cache for Meta calls (TRD §5.2, dev cost saver).
 * Key = sha256(model + system + user + schemaVersion); values are raw
 * response bodies, still zod-validated on every hit — a poisoned cache
 * entry fails validation and falls through to a live call.
 */
export function cacheKey(model: string, system: string, user: string, schemaVersion: string): string {
  return createHash("sha256").update(`v1:${model}\n${system}\n${user}\n${schemaVersion}`).digest("hex");
}

export class FileCache {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  get(key: string): string | null {
    const p = join(this.dir, `${key}.json`);
    if (!/^[0-9a-f]{64}$/.test(key) || !existsSync(p)) return null;
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }
  set(key: string, value: string): void {
    if (!/^[0-9a-f]{64}$/.test(key)) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${key}.json`), value);
    } catch {
      // Cache writes are best-effort; a full disk must not fail the call.
    }
  }
}

/** Resolve the cache dir: explicit > RIPPLEWITNESS_HOME/cache; null when disabled. */
export function resolveCacheDir(explicit?: string): string | null {
  if (process.env.RIPPLEWITNESS_NO_CACHE === "1") return null;
  if (explicit) return explicit;
  const home = process.env.RIPPLEWITNESS_HOME;
  return home ? join(home, "cache") : null;
}
