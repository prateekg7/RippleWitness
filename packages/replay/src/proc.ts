import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * Tracked child-process registry. Every spawned child is detached in its own
 * process group so teardown kills the whole tree (tsx wrappers included).
 */
export class ProcRegistry {
  private children = new Set<ChildProcess>();

  spawn(cmd: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: "ignore" });
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    return child;
  }

  async killAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    for (const child of [...this.children]) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
      this.children.delete(child);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  get size(): number {
    return this.children.size;
  }
}
