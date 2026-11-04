import { describe, expect, it } from "vitest";
import { envText } from "./env.js";

describe("envText", () => {
  it("treats blank values as unset and trims the rest", () => {
    expect(envText(undefined)).toBeUndefined();
    expect(envText("")).toBeUndefined();
    expect(envText("   ")).toBeUndefined();
    expect(envText("muse")).toBe("muse");
    expect(envText("  key-with-padding  ")).toBe("key-with-padding");
  });
});
