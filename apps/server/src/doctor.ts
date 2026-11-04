import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, fallbackChainLabels } from "@ripplewitness/agents";

const run = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function versionOf(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 5000 });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

/** FR-22: environment checks. Reports presence/version only — never secret values. */
export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: nodeMajor >= 22,
    detail: `node ${process.versions.node} (need >=22)`,
  });
  const git = await versionOf("git", ["--version"]);
  checks.push({ name: "git", ok: git !== null, detail: git ?? "git not found (need >=2.40)" });
  const musePath = env.MUSE_BINARY_PATH ?? "muse";
  const muse = await versionOf(musePath, ["--version"]);
  checks.push({
    name: "muse",
    ok: muse !== null,
    detail: muse ?? `${musePath} not found — live-agent features degrade to NO-AGENT`,
  });
  checks.push({
    name: "meta_api_key",
    ok: Boolean(env.META_API_KEY),
    detail: env.META_API_KEY ? "META_API_KEY is set (value not shown)" : "META_API_KEY unset — NO-LLM mode",
  });
  const primary = {
    model: env.META_MODEL ?? DEFAULT_MODEL,
    baseUrl: env.META_BASE_URL ?? DEFAULT_BASE_URL,
  };
  let fallbackDetail = "";
  try {
    const labels = fallbackChainLabels(primary, env);
    if (labels.length > 0) fallbackDetail = ` fallback=${labels.join(" + ")}`;
  } catch {
    fallbackDetail = " fallback=misconfigured (check META_FALLBACK_* lists and loopback/same-origin boundary)";
  }
  checks.push({
    name: "meta_model",
    ok: true,
    detail: `model=${env.META_MODEL ?? `${DEFAULT_MODEL} (default)`} endpoint=${env.META_BASE_URL ?? `${DEFAULT_BASE_URL} (default)`}${fallbackDetail}`,
  });
  const docker = await versionOf("docker", ["--version"]);
  const unshare = await versionOf("unshare", ["--version"]);
  checks.push({
    name: "network_isolation",
    ok: docker !== null || unshare !== null,
    detail:
      docker !== null || unshare !== null
        ? "docker/unshare present (daemon/support still to verify, S-03)"
        : "no docker/unshare — replay falls back to EXTERNAL_MODE=mock (S-03)",
  });
  return checks;
}
