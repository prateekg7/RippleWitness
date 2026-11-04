import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { JudgeGuide } from "../components/JudgeGuide.js";

export function NewRun(props: { onCreated: (runId: string) => void }): React.JSX.Element {
  const [repoPath, setRepoPath] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [headRef, setHeadRef] = useState("HEAD");
  const [scenariosDir, setScenariosDir] = useState("");
  const [appDir, setAppDir] = useState("");
  const [seedDbRel, setSeedDbRel] = useState("");
  const [appStart, setAppStart] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [runs, setRuns] = useState<{ id: string; status: string; createdAt: string }[]>([]);

  useEffect(() => {
    api
      .runs()
      .then((r) => setRuns(r.runs))
      .catch(() => {});
    api
      .config()
      .then((r) => {
        if (!r.lockedRun) return;
        setLocked(true);
        setRepoPath(r.lockedRun.repoPath);
        setBaseRef(r.lockedRun.baseRef);
        setHeadRef(r.lockedRun.headRef);
        setScenariosDir(r.lockedRun.scenariosDir);
        if (r.lockedRun.seedDbRel) setSeedDbRel(r.lockedRun.seedDbRel);
        if (r.lockedRun.appStart) setAppStart(r.lockedRun.appStart.join(" "));
      })
      .catch(() => {});
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const argv = appStart.trim();
      const r = await api.analyze({
        repoPath,
        baseRef,
        headRef,
        scenariosDir,
        ...(appDir.trim() ? { appDir: appDir.trim() } : {}),
        ...(seedDbRel.trim() ? { seedDbRel: seedDbRel.trim() } : {}),
        ...(argv ? { appStart: argv.split(/\s+/) } : {}),
      });
      props.onCreated(r.runId);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guide-layout">
      <div className="guide-content">
    <section>
      <h2>New review</h2>
      {locked && (
        <p className="muted">
          Hosted demo: the subject repository, refs, scenarios, seed, and start command below are pre-filled and
          locked — you do not need to enter any parameters. Press <strong>Analyze</strong>, wait for the run, then
          lock your prediction on the next screen before the reveal.
        </p>
      )}
      <label>
        Subject repo path
        <input type="text" value={repoPath} disabled={locked} onChange={(e) => setRepoPath(e.target.value)} placeholder="/path/to/subject-repo" />
      </label>
      <label>
        Base ref <input type="text" value={baseRef} disabled={locked} onChange={(e) => setBaseRef(e.target.value)} />
      </label>
      <label>
        Head ref <input type="text" value={headRef} disabled={locked} onChange={(e) => setHeadRef(e.target.value)} />
      </label>
      <label>
        Scenarios dir
        <input type="text" value={scenariosDir} disabled={locked} onChange={(e) => setScenariosDir(e.target.value)} placeholder="/path/to/demo/scenarios" />
      </label>
      <details>
        <summary>Advanced (app dir, seed DB, start command)</summary>
        <label>
          App dir (default: repo root)
          <input type="text" value={appDir} disabled={locked} onChange={(e) => setAppDir(e.target.value)} placeholder="." />
        </label>
        <label>
          Seed DB path, app-relative (default: seed/seed.db)
          <input type="text" value={seedDbRel} disabled={locked} onChange={(e) => setSeedDbRel(e.target.value)} placeholder="seed/seed.db" />
        </label>
        <label>
          Start command, space-separated (default: package.json start)
          <input type="text" value={appStart} disabled={locked} onChange={(e) => setAppStart(e.target.value)} placeholder="node server.js" />
        </label>
      </details>
      {error && <p className="error">{error}</p>}
      <button onClick={() => void submit()} disabled={busy || !repoPath || !scenariosDir}>
        {busy ? "Starting…" : "Analyze"}
      </button>
      {runs.length > 0 && (
        <div>
          <h3>{locked ? "Recorded run — open it, lock a prediction, see the graded reveal" : "Recent runs"}</h3>
          <ul>
            {runs.map((r) => (
              <li key={r.id}>
                <a href={`#/runs/${r.id}`}>{r.id.slice(0, 8)}…</a> — {r.status} — {r.createdAt}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
      </div>
      <JudgeGuide stage="start" hosted={locked} />
    </div>
  );
}
