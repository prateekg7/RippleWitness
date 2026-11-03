import { describe, expect, it } from "vitest";
import { buildLlmOptions } from "./serve.js";

describe("prod LLM wiring (BUG-002)", () => {
  it("wires all six agents with a key, none without", () => {
    const withKey = buildLlmOptions("k");
    expect(typeof withKey.extractor).toBe("function");
    expect(typeof withKey.reviewer).toBe("function");
    expect(typeof withKey.explainer).toBe("function");
    expect(typeof withKey.summarizer).toBe("function");
    expect(typeof withKey.phraser).toBe("function");
    expect(typeof withKey.planner).toBe("function");
    expect(buildLlmOptions(undefined)).toEqual({});
    expect(buildLlmOptions("")).toEqual({});
  });
});
