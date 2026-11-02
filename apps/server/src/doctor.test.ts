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
    expect(JSON.stringify(checks)).not.toContain("sk-test-not-real");
  });
});
