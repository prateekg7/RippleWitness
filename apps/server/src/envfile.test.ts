import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv, parseDotEnv } from "./envfile.js";

describe(".env loading for local runs", () => {
  it("parses exports, quotes, comments, and blank placeholders", () => {
    expect(
      parseDotEnv(["# comment", "META_API_KEY=", "export META_MODEL='muse-spark-1.3'", 'QUOTED="a b"', "BAD LINE"].join("\n")),
    ).toEqual({ META_API_KEY: "", META_MODEL: "muse-spark-1.3", QUOTED: "a b" });
  });

  it("finds the repo-root .env from a nested package directory without overriding real env", () => {
    const root = mkdtempSync(join(tmpdir(), "rw-env-"));
    const nested = join(root, "apps", "server");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".env"), "META_API_KEY=from-file\nMETA_MODEL=file-model\nBLANK_FIRST=file-value\n");
    const env: Record<string, string | undefined> = { META_MODEL: "shell-model", BLANK_FIRST: "" };
    expect(loadDotEnv(nested, env)).toBe(join(root, ".env"));
    expect(env.META_API_KEY).toBe("from-file");
    expect(env.META_MODEL).toBe("shell-model");
    expect(env.BLANK_FIRST).toBe("file-value");
  });
});
