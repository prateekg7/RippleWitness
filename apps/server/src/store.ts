import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export interface RunRow {
  id: string;
  repoPath: string;
  baseRef: string;
  headRef: string;
  status: string;
  stages: string;
  prediction: string | null;
  score: string | null;
  locked: number;
  overrideReason: string | null;
  createdAt: string;
}

export function openStore(dbPath?: string): Database.Database {
  const file =
    dbPath ?? join(process.env.RIPPLEWITNESS_HOME ?? join(process.cwd(), ".ripplewitness"), "runs.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, baseRef TEXT NOT NULL, headRef TEXT NOT NULL,
      status TEXT NOT NULL, stages TEXT NOT NULL DEFAULT '{}',
      prediction TEXT, score TEXT, locked INTEGER NOT NULL DEFAULT 0,
      overrideReason TEXT, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      runId TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (runId, kind)
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL, template TEXT NOT NULL,
      routeId TEXT, claimId TEXT, status TEXT NOT NULL DEFAULT 'OPEN',
      askedCount INTEGER NOT NULL DEFAULT 0, answer TEXT, need REAL NOT NULL DEFAULT 0
    );
  `);
  return db;
}

export function putArtifact(db: Database.Database, runId: string, kind: string, body: unknown): void {
  db.prepare("INSERT OR REPLACE INTO artifacts (runId, kind, body) VALUES (?, ?, ?)").run(
    runId,
    kind,
    JSON.stringify(body),
  );
}

export function getArtifact<T>(db: Database.Database, runId: string, kind: string): T | null {
  const row = db.prepare("SELECT body FROM artifacts WHERE runId = ? AND kind = ?").get(runId, kind) as
    | { body: string }
    | undefined;
  return row ? (JSON.parse(row.body) as T) : null;
}
