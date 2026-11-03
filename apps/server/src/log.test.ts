import { describe, expect, it } from "vitest";
import { createLogger, scrubFields } from "./log.js";

describe("structured logging (SEC-06)", () => {
  it("emits one JSON object per line with runId", () => {
    const lines: string[] = [];
    const log = createLogger("run-1", (l) => lines.push(l), () => "2026-01-01T00:00:00.000Z");
    log.info("hello", { n: 1 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      runId: "run-1",
      msg: "hello",
      n: 1,
    });
  });

  it("child loggers carry the run id", () => {
    const lines: string[] = [];
    createLogger(undefined, (l) => lines.push(l)).child("r2").warn("w");
    expect((JSON.parse(lines[0] as string) as { runId: string }).runId).toBe("r2");
  });

  it("redacts secret keys and secret-shaped values", () => {
    expect(scrubFields({ apiKey: "sk-abcdef123456", port: 4400 })).toEqual({ apiKey: "[redacted]", port: 4400 });
    expect(scrubFields({ detail: "token abc secret=hunter2 ok" }).detail).not.toContain("hunter2");
    const lines: string[] = [];
    const log = createLogger("r", (l) => lines.push(l));
    log.info("login", { authorization: "Bearer abc.def.ghi", note: "password: s3cr3t!" });
    expect(lines[0]).not.toContain("abc.def.ghi");
    expect(lines[0]).not.toContain("s3cr3t!");
  });

  it("honors RIPPLEWITNESS_LOG_LEVEL", () => {
    const prev = process.env.RIPPLEWITNESS_LOG_LEVEL;
    process.env.RIPPLEWITNESS_LOG_LEVEL = "warn";
    try {
      const lines: string[] = [];
      const log = createLogger("r", (l) => lines.push(l));
      log.info("hidden");
      log.error("shown");
      expect(lines).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.RIPPLEWITNESS_LOG_LEVEL;
      else process.env.RIPPLEWITNESS_LOG_LEVEL = prev;
    }
  });
});
