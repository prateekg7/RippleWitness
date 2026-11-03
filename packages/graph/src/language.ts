import { existsSync } from "node:fs";
import { join } from "node:path";

export type SubjectLanguage = "node" | "python" | "go";

/**
 * Detect the subject language from manifest files (TRD §7.2, J-01).
 * `tsconfig.json` / `package.json` → node (TS and JS alike);
 * `requirements.txt` / `pyproject.toml` / `setup.py` → python;
 * `go.mod` → go.
 * Node wins when several are present (a Node subject may vendor other
 * languages); an explicit `language` in the analyze request always wins.
 */
export function detectLanguage(appRoot: string): SubjectLanguage | "unknown" {
  const has = (f: string): boolean => {
    try {
      return existsSync(join(appRoot, f));
    } catch {
      return false;
    }
  };
  if (has("package.json") || has("tsconfig.json")) return "node";
  if (has("requirements.txt") || has("pyproject.toml") || has("setup.py")) return "python";
  if (has("go.mod")) return "go";
  return "unknown";
}
