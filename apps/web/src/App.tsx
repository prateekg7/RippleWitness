import React, { useState } from "react";
import { NewRun } from "./pages/NewRun.js";
import { RunView } from "./pages/RunView.js";

function runIdFromHash(): string | null {
  const m = /^#\/runs\/(.+)$/.exec(window.location.hash);
  return m ? (m[1] as string) : null;
}

export function App(): React.JSX.Element {
  const [runId, setRunId] = useState<string | null>(runIdFromHash());
  React.useEffect(() => {
    const onHash = (): void => setRunId(runIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <>
      <header>
        <h1>RIPPLEWITNESS</h1>
        <a href="#">new review</a>
      </header>
      <main>{runId ? <RunView runId={runId} /> : <NewRun onCreated={(id) => (window.location.hash = `#/runs/${id}`)} />}</main>
      <footer>Local-first review cockpit. No data leaves this machine except minimal Meta model prompts.</footer>
    </>
  );
}
