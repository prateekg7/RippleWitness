import { spawnSync } from "node:child_process";

/**
 * Subject-execution sandbox helpers (SEC-01). Status: OS-level network
 * isolation (unshare/Docker) is detected and reported but NOT enforced —
 * unshare -n breaks the localhost replay socket without root, and Docker
 * needs a daemon + per-subject image (see TRD §7.3). What IS enforced:
 * subject processes get an allow-list environment with proxy variables
 * scrubbed, EXTERNAL_MODE=mock, and every outbound attempt appended to
 * OUTBOUND_LOG by the subject contract (asserted in replay tests).
 */

/** Env vars never passed to subject code: proxies would punch through mock mode. */
export const REPLAY_ENV_DENY = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "http_proxy_host",
] as const;

export interface SandboxReport {
  platform: string;
  unshare: boolean;
  docker: boolean;
  /** Effective enforcement. Always "mock-flag" until OS isolation lands. */
  enforcement: "mock-flag";
  note: string;
}

/** Drop deny-listed keys from an env mapping. Pure. */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const deny = new Set<string>(REPLAY_ENV_DENY);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (deny.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Proxy unsetter for execa-style merged envs: execa deletes keys explicitly
 * set to undefined, which kills proxies inherited from the parent process.
 */
export function unsetProxies(): Record<string, undefined> {
  return Object.fromEntries(REPLAY_ENV_DENY.map((k) => [k, undefined]));
}

/** Best-effort OS isolation capability probe. Never throws. */
export function describeSandbox(): SandboxReport {
  const platform = process.platform;
  const unshare = have(["unshare", "--version"]);
  const docker = have(["docker", "--version"]);
  return {
    platform,
    unshare,
    docker,
    enforcement: "mock-flag",
    note:
      unshare || docker
        ? "unshare/docker present but not enforced (localhost replay needs loopback; see TRD §7.3)"
        : "no OS isolation available — EXTERNAL_MODE=mock + proxy scrub + outbound log",
  };
}

function have(cmd: string[]): boolean {
  try {
    const r = spawnSync(cmd[0] as string, cmd.slice(1), { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
