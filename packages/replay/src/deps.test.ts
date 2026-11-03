import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverGoStartCommand, ensureDeps, hashManifests, pnpmLauncher } from "./deps.js";

describe("go dependency lifecycle (M-07)", () => {
  it("discovers `go run` from go.mod, null without it", () => {
    const bare = mkdtempSync(join(tmpdir(), "rw-godeps-bare-"));
    expect(discoverGoStartCommand(bare)).toBeNull();
    const root = mkdtempSync(join(tmpdir(), "rw-godeps-root-"));
    writeFileSync(join(root, "go.mod"), "module shopgo\n\ngo 1.22\n");
    // Standard layout only: nested main packages use an explicit appStart.
    expect(discoverGoStartCommand(root)).toEqual(["go", "run", "."]);
  });

  it("hashManifests is sensitive to go.mod/go.sum", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-gohash-"));
    writeFileSync(join(dir, "go.mod"), "module shopgo\n\ngo 1.22\n");
    const h1 = hashManifests(dir);
    writeFileSync(join(dir, "go.sum"), "example.com/mod v1.0.0 h1:abc=\n");
    expect(hashManifests(dir)).not.toBe(h1);
  });

  it("ensureDeps replaces a committed real node_modules directory", async () => {
    const src = mkdtempSync(join(tmpdir(), "rw-deps-src-"));
    mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(src, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "s", version: "1.0.0" }));
    const wt = mkdtempSync(join(tmpdir(), "rw-deps-wt-"));
    mkdirSync(join(wt, "node_modules", "stale"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "stale", "index.js"), "y");
    writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "s", version: "1.0.0" }));
    const r = await ensureDeps(src, wt, "same", "same");
    expect(r.strategy).toBe("symlink");
    expect(readFileSync(join(wt, "node_modules", "pkg", "index.js"), "utf8")).toBe("x");
  });

  it("pnpmLauncher prefers pnpm on PATH, else corepack", () => {
    expect(pnpmLauncher().length).toBeGreaterThanOrEqual(1);
    expect(pnpmLauncher()[pnpmLauncher().length - 1]).toBe("pnpm");
  });

  it("ensureDeps skips when the Go toolchain is preinstalled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-goensure-"));
    writeFileSync(join(dir, "go.mod"), "module shopgo\n\ngo 1.22\n");
    const r = await ensureDeps(dir, dir, "a", "a", { language: "go" });
    expect(r.strategy).toBe("none");
  });
});
