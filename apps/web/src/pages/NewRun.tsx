import React, { useState } from "react";
import { api } from "../api.js";

export function NewRun(props: { onCreated: (runId: string) => void }): React.JSX.Element {
  const [repoPath, setRepoPath] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [headRef, setHeadRef] = useState("HEAD");
  const [scenariosDir, setScenariosDir] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const r = await api.analyze({ repoPath, baseRef, headRef, scenariosDir });
      props.onCreated(r.runId);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>New review</h2>
      <label>
        Subject repo path
        <input type="text" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/path/to/subject-repo" />
      </label>
      <label>
        Base ref <input type="text" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
      </label>
      <label>
        Head ref <input type="text" value={headRef} onChange={(e) => setHeadRef(e.target.value)} />
      </label>
      <label>
        Scenarios dir
        <input type="text" value={scenariosDir} onChange={(e) => setScenariosDir(e.target.value)} placeholder="/path/to/demo/scenarios" />
      </label>
      {error && <p className="error">{error}</p>}
      <button onClick={() => void submit()} disabled={busy || !repoPath || !scenariosDir}>
        {busy ? "Starting…" : "Analyze"}
      </button>
    </section>
  );
}
