import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLanguage } from "./language.js";
import { extractStaticGraph } from "./extract.js";

function stage(files: Record<string, string>): string {
  const dir = join(tmpdir(), `rw-lang-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("subject language detection (J-01)", () => {
  it("node via package.json or tsconfig.json", () => {
    expect(detectLanguage(stage({ "package.json": "{}" }))).toBe("node");
    expect(detectLanguage(stage({ "tsconfig.json": "{}" }))).toBe("node");
  });
  it("python via requirements.txt, pyproject.toml, or setup.py", () => {
    expect(detectLanguage(stage({ "requirements.txt": "fastapi\n" }))).toBe("python");
    expect(detectLanguage(stage({ "pyproject.toml": "[project]\n" }))).toBe("python");
    expect(detectLanguage(stage({ "setup.py": "x=1\n" }))).toBe("python");
  });
  it("unknown when no manifest exists; node wins mixed trees", () => {
    expect(detectLanguage(stage({ "README.md": "hi\n" }))).toBe("unknown");
    expect(detectLanguage(stage({ "package.json": "{}", "requirements.txt": "x\n" }))).toBe("node");
  });
  it("explicit python opts route away from ts-morph", () => {
    const dir = stage({ "requirements.txt": "fastapi\n" });
    expect(() => extractStaticGraph(dir, { language: "python" })).toThrow(/J-03/);
  });
});
