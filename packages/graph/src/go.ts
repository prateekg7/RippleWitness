import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { StaticGraph } from "./types.js";

const execFileP = promisify(execFile);

const GraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["route", "handler", "service", "db_table", "config"]),
      label: z.string(),
      file: z.string().optional(),
      range: z.tuple([z.number(), z.number()]).optional(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      type: z.enum(["calls", "reads", "writes", "config"]),
      confidence: z.enum(["EXTRACTED", "INFERRED"]),
    }),
  ),
});

function programPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "go", "extract.go");
}

/**
 * Go static extraction (roadmap, TRD §7.1.3). Runs the stdlib-only `extract.go`
 * against the subject tree via `go run` and zod-validates its JSON output
 * like every external input. Deterministic: same tree → same bytes.
 * Requires a Go toolchain on PATH.
 */
export async function extractGoGraph(appRoot: string): Promise<StaticGraph> {
  // The extractor is stdlib-only (no module downloads); point the build cache
  // at tmp so sandboxed and HOME-less runs work. Honors an explicit GOCACHE.
  const { stdout } = await execFileP("go", ["run", programPath(), appRoot], {
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GOCACHE: process.env.GOCACHE || join(tmpdir(), "rw-go-build") },
  });
  return GraphSchema.parse(JSON.parse(stdout)) as StaticGraph;
}
