import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { MapNode, Reveal } from "../api.js";

function StatusPill(props: { status: string }): React.JSX.Element {
  return <span className={`pill ${props.status.toLowerCase()}`}>{props.status}</span>;
}

function AssistantsBox(props: { runId: string }): React.JSX.Element {
  const [note, setNote] = useState("");
  const [out, setOut] = useState("");
  return (
    <div>
      <p className="muted">Submit your own finding first — AI review unlocks after.</p>
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="file:start-end note (e.g. src/app.ts:40-44 check rounding)" />
      <button
        onClick={() => {
          const m = /^(\S+):(\d+)-(\d+)\s+(.+)$/.exec(note);
          if (!m) { setOut("format: file:start-end note"); return; }
          void api.findings(props.runId, [{ file: m[1] as string, startLine: Number(m[2]), endLine: Number(m[3]), note: m[4] as string }])
            .then((r) => setOut(`recorded ${r.recorded}`)).catch((e: unknown) => setOut(String(e)));
        }}
      >
        Submit finding
      </button>{" "}
      <button className="secondary" onClick={() => void api.aiReview(props.runId).then((r) => setOut(`AI: ${r.valid.length} valid, ${r.rejected.length} rejected — ${r.valid.map((f) => `${f.file}:${f.startLine} ${f.note}`).join(" | ") || "none"}`)).catch((e: unknown) => setOut(String(e)))}>
        Run AI review
      </button>
      {out && <p>{out}</p>}
    </div>
  );
}

function SummaryBox(props: { runId: string }): React.JSX.Element {
  const [out, setOut] = useState("");
  return (
    <div>
      <button onClick={() => void api.summary(props.runId).then((r) => setOut(`${r.summary.title} — unverified: ${r.summary.unverified.join(", ") || "none"}`)).catch((e: unknown) => setOut(String(e)))}>Write summary</button>
      {out && <p>{out}</p>}
    </div>
  );
}

function ReceiptBox(props: { runId: string }): React.JSX.Element {
  const [trailer, setTrailer] = useState("");
  const [error, setError] = useState("");
  return (
    <div>
      <button onClick={() => void api.receipt(props.runId).then((r) => { setTrailer(r.trailer); setError(""); }).catch((e: unknown) => setError(String(e)))}>Issue receipt</button>
      {trailer && <p className="muted">{trailer}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function CanaryBox(props: { runId: string }): React.JSX.Element {
  const [file, setFile] = useState("src/app.ts");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <p className="muted">Plant a validated mutation to test your own attention. Never touches the repo.</p>
      <input type="text" value={file} onChange={(e) => setFile(e.target.value)} />
      <button disabled={busy} onClick={() => { setBusy(true); void api.canary(props.runId, file).then((r) => setResult(`${r.verdict.accepted ? "ACCEPTED" : "REJECTED"} ${r.candidate.operator} @${r.candidate.file}:${r.candidate.line} — ${r.verdict.reason}`)).catch((e: unknown) => setResult(String(e))).finally(() => setBusy(false)); }}>
        {busy ? "Validating…" : "Arm canary"}
      </button>
      {result && <p>{result}</p>}
    </div>
  );
}

export function RunView(props: { runId: string }): React.JSX.Element {
  const { runId } = props;
  const [status, setStatus] = useState("loading");
  const [locked, setLocked] = useState(false);
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [nothingElse, setNothingElse] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [agentText, setAgentText] = useState("");
  const [override, setOverride] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await api.status(runId);
      setStatus(s.status);
      setLocked(s.locked === 1);
      if (s.status === "ready" || s.status === "static-only") {
        const m = await api.map(runId);
        setNodes(m.nodes);
      }
      if (s.locked === 1) {
        setReveal(await api.reveal(runId));
      }
    } catch (err) {
      setError(String(err));
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (status === "running" || status === "loading") void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [refresh, status]);

  const toggle = (r: string): void =>
    setSelected((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]));

  if (status === "loading" || status === "running") return <section><h2>Analyzing…</h2><p className="muted">graph + replay running</p></section>;
  if (status === "static-only")
    return <section><h2>Static only</h2><p className="error">Replay failed; the gate is disabled. Diff and static map still available.</p></section>;
  if (status === "failed") return <section><h2>Failed</h2><p className="error">Analysis failed.</p></section>;

  return (
    <>
      {error && <section><p className="error">{error}</p></section>}
      <section>
        <h2>Blast map {locked ? "(revealed)" : "(predict first)"}</h2>
        <table>
          <thead><tr><th>Route</th><th>Static</th><th>Exercised</th>{locked && <th>Status</th>}{!locked && <th>Will change?</th>}</tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.routeId}>
                <td>{n.routeId}</td>
                <td>{n.staticImpacted ? "yes" : "—"}</td>
                <td>{n.exercised ? "yes" : "no"}</td>
                {locked && <td>{n.status ? <StatusPill status={n.status} /> : "—"}</td>}
                {!locked && (
                  <td><input type="checkbox" checked={selected.includes(n.routeId)} onChange={() => toggle(n.routeId)} aria-label={n.routeId} /></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!locked && (
          <div style={{ marginTop: 8 }}>
            <label><input type="checkbox" checked={nothingElse} onChange={(e) => setNothingElse(e.target.checked)} /> Nothing else changes</label>
            <button onClick={() => void api.predict(runId, { routeIds: selected, nothingElse }).then(refresh).catch((e: unknown) => setError(String(e)))}>Lock prediction</button>
          </div>
        )}
      </section>

      {locked && reveal && (
        <>
          <section>
            <h2>Gate score</h2>
            <p>
              recall {reveal.score.recall.toFixed(2)} · precision {reveal.score.precision.toFixed(2)} ·{" "}
              {reveal.score.passed ? "PASSED" : "MISSED"} ({reveal.score.passReason})
            </p>
            {reveal.score.misses.length > 0 && (
              <table>
                <thead><tr><th>Missed route</th><th>Cause</th></tr></thead>
                <tbody>{reveal.score.misses.map((m) => <tr key={m.routeId}><td>{m.routeId}</td><td>{m.cause}</td></tr>)}</tbody>
              </table>
            )}
            {!reveal.score.passed && !reveal.overrideReason && (
              <div style={{ marginTop: 8 }}>
                <input type="text" value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Override reason (recorded)" />
                <button className="secondary" onClick={() => void api.override(runId, override).then(refresh)}>Override with reason</button>
              </div>
            )}
            {reveal.overrideReason && <p className="muted">Overridden: {reveal.overrideReason}</p>}
          </section>

          <section>
            <h2>Agent claims ({reveal.claims.length})</h2>
            {reveal.claims.length === 0 && <p className="muted">No claims extracted. Paste the agent summary below (needs META_API_KEY).</p>}
            <table>
              <tbody>
                {reveal.claims.map((c) => (
                  <tr key={c.claimId}><td>{c.type}</td><td>{c.text}</td><td>{c.verdict}</td></tr>
                ))}
              </tbody>
            </table>
            <textarea rows={3} value={agentText} onChange={(e) => setAgentText(e.target.value)} placeholder="Agent final summary…" />
            <button onClick={() => void api.agentMessage(runId, agentText).then(refresh).catch((e: unknown) => setError(String(e)))}>Extract + verify claims</button>
          </section>

          <section>
            <h2>Receipt</h2>
            <ReceiptBox runId={runId} />
          </section>

          <section>
            <h2>Canary</h2>
            <CanaryBox runId={runId} />
          </section>

          <section>
            <h2>Blind-first review</h2>
            <AssistantsBox runId={runId} />
          </section>

          <section>
            <h2>Summary</h2>
            <SummaryBox runId={runId} />
          </section>

          <section>
            <h2>Questions ({reveal.questions.length})</h2>
            {reveal.questions.map((q) => (
              <div key={q.id} style={{ borderTop: "1px solid #16130e", padding: "6px 0" }}>
                <p><strong>[{q.template}]</strong> {q.text} <span className="muted">({q.status})</span></p>
                {q.answer && <p className="muted">A: {q.answer}</p>}
                {(q.status === "OPEN" || q.status === "ASKED") && (
                  <button className="secondary" onClick={() => void api.ask(runId, q.id).then(refresh)}>Ask agent</button>
                )}
              </div>
            ))}
          </section>
        </>
      )}
    </>
  );
}
