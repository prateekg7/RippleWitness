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
  const [configLoaded, setConfigLoaded] = useState(false);
  const [runs, setRuns] = useState<{ id: string; status: string; createdAt: string }[]>([]);

  useEffect(() => {
    const loadRuns = (): void => {
      api
        .runs()
        .then((r) => setRuns(r.runs))
        .catch(() => {});
    };
    loadRuns();
    // The hosted server may still be seeding its prepared run on first boot.
    const timer = setInterval(loadRuns, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
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
      .catch(() => {})
      .finally(() => setConfigLoaded(true));
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

  const demoRun = runs[0];

  if (!configLoaded) {
    return (
      <div className="guide-layout">
        <div className="guide-content">
          <section>
            <h2>Preparing demo…</h2>
            <p className="muted">Checking whether this is the hosted judge demo or a local review.</p>
          </section>
        </div>
        <JudgeGuide stage="loading" />
      </div>
    );
  }

  if (locked) {
    return (
      <div className="guide-layout">
        <div className="guide-content">
          <section>
            <h2>Hosted judge demo</h2>
            <p>
              This demo is already configured for the real <strong>typicode/json-server</strong> change.
              No repository path, directory, ref, scenario folder, or start command is needed from you.
            </p>
            <p className="muted">
              Open the prepared run to make your prediction and see it graded by execution. Run a fresh
              analysis only if you want to watch the complete pipeline run again.
            </p>
            {demoRun ? (
              <div>
                <button onClick={() => props.onCreated(demoRun.id)}>Open the prepared demo</button>{" "}
                <button className="secondary" onClick={() => void submit()} disabled={busy}>
                  {busy ? "Starting…" : "Run a fresh analysis"}
                </button>
                <p className="muted">
                  Prepared run: {demoRun.status} · created {demoRun.createdAt}
                </p>
              </div>
            ) : (
              <button onClick={() => void submit()} disabled={busy}>
                {busy ? "Starting demo analysis…" : "Analyze the demo"}
              </button>
            )}
            {error && <p className="error">{error}</p>}
          </section>
        </div>
        <JudgeGuide stage="start" hosted />
      </div>
    );
  }

  return (
    <div className="guide-layout">
      <div className="guide-content">
    <section>
      <h2>New review</h2>
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
