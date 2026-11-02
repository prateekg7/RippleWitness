import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** Local HMAC key. Created once with 0600; never logged (AGENTS A3). */
export function loadOrCreateKey(home: string): Buffer {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "key");
  if (existsSync(path)) return readFileSync(path);
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

export function keyPath(home: string): string {
  return join(home, "key");
}
