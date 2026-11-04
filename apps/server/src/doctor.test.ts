import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctor.js";

describe("doctor (FR-22 stub)", () => {
  it("reports node/git without leaking secret values", async () => {
    const checks = await runDoctor({ META_API_KEY: "sk-test-not-real" } as NodeJS.ProcessEnv);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.node?.ok).toBe(true);
    expect(byName.git?.ok).toBe(true);
    expect(byName.meta_api_key?.ok).toBe(true);
    expect(byName.meta_model?.detail).toContain("muse-spark-1.3 (default)");
    const custom = await runDoctor({ META_MODEL: "m", META_BASE_URL: "https://e.example" } as NodeJS.ProcessEnv);
    expect(custom.find((c) => c.name === "meta_model")?.detail).toBe("model=m endpoint=https://e.example");
    // Blank .env placeholders (from `set -a; source .env`) must behave as unset,
    // not as empty overrides: an empty MUSE_BINARY_PATH must not shadow `muse`.
    const blank = await runDoctor({ MUSE_BINARY_PATH: "", META_MODEL: "", META_BASE_URL: "" } as NodeJS.ProcessEnv);
    const blankModel = blank.find((c) => c.name === "meta_model")?.detail ?? "";
    expect(blankModel).toContain("muse-spark-1.3 (default)");
    expect(blankModel).toContain("https://api.meta.ai/v1 (default)");
    const blankMuse = blank.find((c) => c.name === "muse")?.detail ?? "";
    expect(blankMuse.startsWith(" not found")).toBe(false);
    const mismatched = await runDoctor({
      META_FALLBACK_MODELS: "open-one,open-two",
      META_FALLBACK_BASE_URLS: "http://127.0.0.1:8000/v1",
    } as NodeJS.ProcessEnv);
    expect(mismatched.find((c) => c.name === "meta_model")?.detail).toContain("fallback=misconfigured");
    const remote = await runDoctor({
      META_FALLBACK_MODELS: "open-one",
      META_FALLBACK_BASE_URLS: "https://models.example.com/v1",
    } as NodeJS.ProcessEnv);
    expect(remote.find((c) => c.name === "meta_model")?.detail).toContain("fallback=misconfigured");
    const fallback = await runDoctor({
      META_FALLBACK_MODELS: "open-one,open-two",
      META_FALLBACK_BASE_URLS: "http://127.0.0.1:8000/v1,http://127.0.0.1:8001/v1",
      META_FALLBACK_API_KEYS: "fallback-secret,",
    } as NodeJS.ProcessEnv);
    expect(fallback.find((c) => c.name === "meta_model")?.detail).toBe(
      "model=muse-spark-1.3 (default) endpoint=https://api.meta.ai/v1 (default) fallback=open-one@http://127.0.0.1:8000/v1 + open-two@http://127.0.0.1:8001/v1",
    );
    expect(JSON.stringify(fallback)).not.toContain("fallback-secret");
    expect(JSON.stringify(checks)).not.toContain("sk-test-not-real");
  });
});
