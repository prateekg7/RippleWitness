import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type AgentMode = "live_session" | "reinstantiated_from_transcript";

export interface AgentAnswer {
  text: string;
  mode: AgentMode;
}

/** TRD §5.1 agent-session port. Q&A is read-only (AGENTS Part C). */
export interface AgentSessionPort {
  ask(question: string, opts?: { workdir?: string }): Promise<AgentAnswer>;
}

/** Scripted answers for tests and NO-AGENT degraded paths. */
export class MockSession implements AgentSessionPort {
  private readonly answers: string[];
  readonly asked: string[] = [];
  constructor(answers: string[] = ["not verified"]) {
    this.answers = answers;
  }
  async ask(question: string): Promise<AgentAnswer> {
    this.asked.push(question);
    const text = this.answers[Math.min(this.asked.length - 1, this.answers.length - 1)] as string;
    return { text, mode: "reinstantiated_from_transcript" };
  }
}

export interface ExecOptions {
  binary?: string;
  provider?: string;
  timeoutMs?: number;
  home?: string;
}

/** Parse `muse exec --json` NDJSON: final text from run.terminal.completed. */
export function parseExecJsonl(ndjson: string): string {
  let last = "";
  for (const line of ndjson.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const rec = JSON.parse(t) as { payload_type?: string; text?: string; payload?: { text?: string } };
      const text = rec.text ?? rec.payload?.text;
      if (typeof text === "string" && text.length > 0) last = text;
    } catch {
      /* skip malformed lines */
    }
  }
  return last;
}

/** Headless sessions via `muse exec --json` (S-01 Step 1). Read-only flags always on. */
export class ExecSession implements AgentSessionPort {
  private readonly binary: string;
  private readonly provider: string;
  private readonly timeoutMs: number;
  private readonly home: string | undefined;
  constructor(opts: ExecOptions = {}) {
    this.binary = opts.binary ?? process.env.MUSE_BINARY_PATH ?? "muse";
    this.provider = opts.provider ?? "meta";
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.home = opts.home;
  }
  async ask(question: string, opts?: { workdir?: string }): Promise<AgentAnswer> {
    const args = [
      "exec",
      "--provider",
      this.provider,
      "--json",
      "--disable-write",
      "--disable-shell",
      "--approval-mode",
      "untrusted",
      question,
    ];
    const env = { ...process.env };
    if (this.home) {
      env.HOME = this.home;
      env.XDG_DATA_HOME = join(this.home, ".local", "share");
      env.XDG_CONFIG_HOME = join(this.home, ".config");
    }
    const { stdout } = await execFileP(this.binary, args, {
      cwd: opts?.workdir,
      env,
      timeout: this.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { text: parseExecJsonl(stdout), mode: "live_session" };
  }
}

function newestFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const found: { path: string; mtime: number }[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name === "session.jsonl") {
        found.push({ path: p, mtime: statSync(p).mtimeMs });
      }
    }
  };
  walk(dir);
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path ?? null;
}

/** Latest transcript path under a session store root (S-01 finding). */
export function findLatestSessionJsonl(storeRoot: string): string | null {
  return newestFile(storeRoot);
}

export interface TranscriptTurn {
  role: string;
  text: string;
}

/** Best-effort transcript read: user/assistant texts from session.jsonl. */
export function loadTranscript(jsonlPath: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const rec = JSON.parse(t) as {
        type?: string;
        role?: string;
        text?: string;
        content?: { type?: string; text?: string }[] | string;
      };
      const text =
        rec.text ?? (typeof rec.content === "string" ? rec.content : rec.content?.find((c) => c.text)?.text);
      if (typeof text === "string" && text.length > 0) {
        turns.push({ role: rec.role ?? rec.type ?? "unknown", text });
      }
    } catch {
      /* skip */
    }
  }
  return turns;
}
