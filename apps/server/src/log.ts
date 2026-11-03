import { redactSecrets } from "@ripplewitness/agents";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SENSITIVE_KEY = /(api[_-]?key|secret|token|password|authorization|private[_-]?key)/i;

/** Scrub secret material from log fields: sensitive keys are dropped, string values redacted. */
export function scrubFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface Logger {
  readonly runId?: string | undefined;
  child(runId: string): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured JSON logger (AGENTS.md A3). One JSON object per line, always
 * carrying runId when bound. Min level via RIPPLEWITNESS_LOG_LEVEL.
 */
export function createLogger(runId?: string, sink?: (line: string) => void, now?: () => string): Logger {
  const min = ORDER[(process.env.RIPPLEWITNESS_LOG_LEVEL as LogLevel) ?? "info"] ?? ORDER.info;
  const emit = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
    if (ORDER[level] < min) return;
    const line = JSON.stringify({ ts: now?.() ?? new Date().toISOString(), level, ...(runId ? { runId } : {}), msg, ...scrubFields(fields) });
    if (sink) sink(line);
    else if (level === "error") console.error(line);
    else console.log(line);
  };
  return {
    runId,
    child: (id: string) => createLogger(id, sink, now),
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}

/** Root logger for startup paths that have no run yet. */
export const log = createLogger();
