import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const SERVER_JS = `import http from "node:http";
import { value } from "./helper.js";
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/health") return json({});
  if (req.url === "/value" && req.method === "GET") return json({ v: value() });
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`;

/** Tiny git subject: GET /value changes base->head; plus scenarios dir. */
export async function buildSubject(): Promise<{ repoPath: string; base: string; head: string; scenariosDir: string }> {
  const repoPath = mkdtempSync(join(tmpdir(), "rw-e2e-subj-"));
  await exec("git", ["init", "-q", "-b", "main", "."], { cwd: repoPath });
  await exec("git", ["config", "user.email", "t@l"], { cwd: repoPath });
  await exec("git", ["config", "user.name", "t"], { cwd: repoPath });
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ type: "module", scripts: { start: "node server.js" } }));
  mkdirSync(join(repoPath, "node_modules"));
  writeFileSync(join(repoPath, "server.js"), SERVER_JS);
  writeFileSync(join(repoPath, "helper.js"), `export function value() { return "base"; }\n`);
  writeFileSync(join(repoPath, "seed.db"), "");
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["commit", "-qm", "base"], { cwd: repoPath });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  await exec("git", ["checkout", "-qb", "pr"], { cwd: repoPath });
  writeFileSync(join(repoPath, "helper.js"), `export function value() { return "head"; }\n`);
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["commit", "-qm", "head"], { cwd: repoPath });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  const scenariosDir = mkdtempSync(join(tmpdir(), "rw-e2e-scen-"));
  writeFileSync(
    join(scenariosDir, "s1.json"),
    JSON.stringify({ id: "s1", group: "g", routeIds: ["route:GET /value"], steps: [{ method: "GET", path: "/value" }] }),
  );
  return { repoPath, base, head, scenariosDir };
}

export async function analyze(
  api: string,
  s: { repoPath: string; base: string; head: string; scenariosDir: string },
  extra: object = {},
): Promise<string> {
  const res = await fetch(`${api}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoPath: s.repoPath,
      baseRef: s.base,
      headRef: s.head,
      scenariosDir: s.scenariosDir,
      seedDbRel: "seed.db",
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(`analyze failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { runId: string }).runId;
}

export async function waitStatus(api: string, runId: string, want: string[], timeoutMs = 180000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${api}/api/runs/${runId}/status`);
    const s = ((await res.json()) as { status: string }).status;
    if (s === "ready" || s === "static-only" || s === "failed") {
      if (!want.includes(s)) throw new Error(`terminal status ${s}, wanted ${want.join("/")}`);
      return s;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`status stuck: ${s}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
