import { createHash } from "node:crypto";
import Database from "better-sqlite3";

/** Per-table SHA-256 over rows ordered by rowid (TRD §7.4). Read-only. */
export function hashDb(dbPath: string): Record<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const out: Record<string, string> = {};
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      out[name] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    }
    return out;
  } finally {
    db.close();
  }
}
