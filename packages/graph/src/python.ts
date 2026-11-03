import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

function scriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "python", "extract.py");
}

/**
 * Python static extraction (F-20, TRD §7.1.2). Spawns the stdlib-only
 * `extract.py` against the subject tree and zod-validates its JSON output
 * like every external input. Deterministic: same tree → same bytes.
 */
export async function extractPythonGraph(appRoot: string): Promise<StaticGraph> {
  const { stdout } = await execFileP("python3", [scriptPath(), appRoot], { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  return GraphSchema.parse(JSON.parse(stdout)) as StaticGraph;
}
