import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { MapNode, Reveal } from "../api.js";

/** Status glyphs: statuses stay distinguishable without color (E2E-07). */
const STATUS_GLYPH: Record<string, string> = {
  SURPRISE: "▲",
  CONTRADICTED: "✕",
  CONFIRMED: "●",
  CLEARED: "○",
  UNVERIFIED: "?",
  QUIET: "·",
  DIFF: "≠",
};

function StatusPill(props: { status: string }): React.JSX.Element {
  const glyph = STATUS_GLYPH[props.status] ?? "▪";
  return (
    <span className={`pill ${props.status.toLowerCase()}`}>
      <span aria-hidden="true">{glyph} </span>
      {props.status}
    </span>
  );
}

function StatusLegend(): React.JSX.Element {
  return (
    <p className="muted">
      {Object.entries(STATUS_GLYPH).map(([s, g]) => `${g} ${s}`).join(" · ")}
    </p>
  );
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
  const [reviewMode, setReviewMode] = useState("full");
  const [locked, setLocked] = useState(false);
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [nothingElse, setNothingElse] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [checklist, setChecklist] = useState<string[]>([]);
  const [showQuiet, setShowQuiet] = useState(false);
  const [agentText, setAgentText] = useState("");
  const [override, setOverride] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await api.status(runId);
      setStatus(s.status);
      setLocked(s.locked === 1);
      setReviewMode(s.reviewMode ?? "full");
      if (s.status === "ready" || s.status === "static-only") {
        const m = await api.map(runId);
        setNodes(m.nodes);
        setChecklist(m.calibration ?? []);
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
        {!locked && checklist.map((c) => <p key={c} className="pill calibration">{c}</p>)}
        {reviewMode === "dynamic-only" && (
          <p className="pill dynamic-only">DYNAMIC-ONLY: no static pass ran — statuses report observed outcomes only, never static claims.</p>
        )}
        {locked && nodes.some((n) => n.status === "QUIET") && (
          <p>
            <label><input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} /> Show quiet routes</label>
          </p>
        )}
        <table>
          <thead><tr><th>Route</th><th>Static</th><th>Exercised</th>{locked && <th>Status</th>}{!locked && <th>Will change?</th>}</tr></thead>
          <tbody>
            {nodes.filter((n) => !locked || showQuiet || n.status !== "QUIET").map((n) => (
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
        {locked && <StatusLegend />}
      </section>

      <section>
        <h2>Diff</h2>
        <DiffView runId={runId} />
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
            <AutoForgeBox runId={runId} refresh={refresh} />
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

          <section>
            <h2>Predict-then-run</h2>
            <FnRunBox runId={runId} />
          </section>

          <section>
            <h2>Causal ablation</h2>
            <AblateBox runId={runId} />
          </section>

          <section>
            <h2>Model usage</h2>
            <MetricsLine runId={runId} />
          </section>
        </>
      )}
    </>
  );
}

function FnRunBox(props: { runId: string }): React.JSX.Element {
  const [fn, setFn] = useState("");
  const [args, setArgs] = useState("[]");
  const [pred, setPred] = useState("");
  const [out, setOut] = useState("");
  return (
    <div>
      <p className="muted">Predict a function output, then grade it by running base vs head. Node: <code>file#export</code>; Python: <code>module:function</code>.</p>
      <input type="text" value={fn} onChange={(e) => setFn(e.target.value)} placeholder="lib/money.js#roundMoney" />{" "}
      <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder='args JSON, e.g. [102.5]' />{" "}
      <input
        type="text"
        value={pred}
        onChange={(e) => setPred(e.target.value)}
        placeholder='{"base": 103, "head": 103}'
      />{" "}
      <button
        onClick={() => {
          let a: unknown[] = [];
          let p: { base?: unknown; head?: unknown } = {};
          try {
            a = JSON.parse(args || "[]") as unknown[];
            p = (JSON.parse(pred || "{}") as { base?: unknown; head?: unknown });
          } catch {
            setOut("invalid JSON in args/predictions");
            return;
          }
          void api
            .fnrun(props.runId, { fn, args: a, predictedBase: p.base, predictedHead: p.head })
            .then((r) => setOut(`base=${JSON.stringify(r.base.value)} head=${JSON.stringify(r.head.value)} baseHit=${r.baseHit} headHit=${r.headHit} changed=${r.changed}`))
            .catch((e: unknown) => setOut(String(e)));
        }}
      >
        Run + grade
      </button>
      {out && <p>{out}</p>}
    </div>
  );
}

type DiffLineT = { type: string; text: string; oldNo: number | null; newNo: number | null };
type DiffHunkT = { header: string; lines: DiffLineT[] };
type DiffFileT = { file: string; truncated: boolean; hunks: DiffHunkT[] };

function DiffView(props: { runId: string }): React.JSX.Element {
  const [files, setFiles] = useState<DiffFileT[]>([]);
  const [split, setSplit] = useState(false);
  const [hunkIdx, setHunkIdx] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    api.diff(props.runId).then((r) => setFiles(r.files)).catch((e: unknown) => setError(String(e)));
  }, [props.runId]);
  const flat: { file: string; hi: number; hunk: DiffHunkT }[] = [];
  files.forEach((f) => f.hunks.forEach((hunk, hi) => flat.push({ file: f.file, hi, hunk })));
  const go = (d: number): void => {
    if (flat.length === 0) return;
    const next = (hunkIdx + d + flat.length) % flat.length;
    setHunkIdx(next);
    document.getElementById(`hunk-${next}`)?.scrollIntoView({ block: "start" });
  };
  if (error) return <p className="error">{error}</p>;
  if (files.length === 0) return <p className="muted">No textual diff (empty or binary-only change).</p>;
  return (
    <div>
      <div>
        <button className="secondary" onClick={() => setSplit(!split)}>{split ? "Stacked view" : "Split view"}</button>{" "}
        <button className="secondary" onClick={() => go(-1)} disabled={flat.length === 0}>← Prev hunk</button>{" "}
        <button className="secondary" onClick={() => go(1)} disabled={flat.length === 0}>Next hunk →</button>{" "}
        <span className="muted">{flat.length} hunks</span>
      </div>
      <ul>
        {files.map((f) => (
          <li key={f.file}>
            <a href={`#file-${f.file}`}>{f.file}</a> <span className="muted">({f.hunks.length} hunks{f.truncated ? ", truncated" : ""})</span>
          </li>
        ))}
      </ul>
      {files.map((f) => (
        <div key={f.file} id={`file-${f.file}`}>
          <h3>{f.file}</h3>
          {f.hunks.map((hunk) => {
            const gi = flat.findIndex((x) => x.file === f.file && x.hunk === hunk);
            return split ? (
              <SplitHunk key={`${f.file}:${hunk.header}`} id={gi} hunk={hunk} />
            ) : (
              <StackedHunk key={`${f.file}:${hunk.header}`} id={gi} hunk={hunk} />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function StackedHunk(props: { id: number; hunk: DiffHunkT }): React.JSX.Element {
  return (
    <div id={`hunk-${props.id}`} className="diff">
      <div className="diff-header">{props.hunk.header}</div>
      {props.hunk.lines.map((l, i) => (
        <div key={i} className={`diff-line diff-${l.type}`}>
          <span className="diff-no">{l.oldNo ?? ""}</span>
          <span className="diff-no">{l.newNo ?? ""}</span>
          <span>{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function SplitHunk(props: { id: number; hunk: DiffHunkT }): React.JSX.Element {
  const left: (DiffLineT | null)[] = [];
  const right: (DiffLineT | null)[] = [];
  for (const l of props.hunk.lines) {
    if (l.type === "context") {
      left.push(l);
      right.push(l);
    } else if (l.type === "del") {
      left.push(l);
      right.push(null);
    } else {
      // Pair adds against preceding unpaired dels for side-by-side reading.
      const slot = right.lastIndexOf(null);
      const leftHasDel = slot >= 0 && left[slot]?.type === "del";
      if (leftHasDel) right[slot] = l;
      else {
        left.push(null);
        right.push(l);
      }
    }
  }
  const cell = (l: DiffLineT | null, side: "old" | "new"): React.JSX.Element => (
    <td className={l ? `diff-${l.type}` : "diff-empty"}>
      <span className="diff-no">{(side === "old" ? l?.oldNo : l?.newNo) ?? ""}</span>{" "}
      {l ? l.text : ""}
    </td>
  );
  return (
    <div id={`hunk-${props.id}`}>
      <div className="diff-header">{props.hunk.header}</div>
      <table className="diff-split">
        <tbody>
          {left.map((l, i) => (
            <tr key={i}>{cell(l, "old")}{cell(right[i] ?? null, "new")}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AutoForgeBox(props: { runId: string; refresh: () => Promise<void> }): React.JSX.Element {
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api
            .autoforge(props.runId)
            .then((r) => setOut(`queued ${r.queued.length}, kept ${r.kept.length}: ${r.kept.join(", ") || "none"}`))
            .catch((e: unknown) => setOut(String(e)))
            .finally(() => {
              setBusy(false);
              void props.refresh();
            });
        }}
      >
        {busy ? "Forging…" : "Close coverage (auto-forge UNVERIFIED)"}
      </button>
      {out && <p className="muted">{out}</p>}
    </div>
  );
}

function AblateBox(props: { runId: string }): React.JSX.Element {
  const [routeId, setRouteId] = useState("");
  const [cands, setCands] = useState<{ kind: string; file: string; event?: string; reason: string }[]>([]);
  const [out, setOut] = useState("");
  return (
    <div>
      <p className="muted">Name a coupling for a changed route; it is neutralised in a third worktree and replayed. Diff gone = CAUSALLY-CONFIRMED.</p>
      <input type="text" value={routeId} onChange={(e) => setRouteId(e.target.value)} placeholder="route:GET /value" />{" "}
      <button
        className="secondary"
        onClick={() => void api.ablations(props.runId, routeId).then((r) => { setCands(r.candidates); setOut(""); }).catch((e: unknown) => setOut(String(e)))}
      >
        Plan
      </button>
      {cands.map((c) => (
        <p key={`${c.kind}:${c.file}:${c.event ?? ""}`}>
          {c.kind} {c.file} {c.event ?? ""} <span className="muted">({c.reason})</span>{" "}
          <button
            className="secondary"
            onClick={() => void api
              .ablate(props.runId, { routeId, kind: c.kind, file: c.file, ...(c.event ? { event: c.event } : {}) })
              .then((r) => setOut(`${r.verdict}: ${r.detail}`))
              .catch((e: unknown) => setOut(String(e)))}
          >
            Run ablation
          </button>
        </p>
      ))}
      {out && <p>{out}</p>}
    </div>
  );
}

function MetricsLine(props: { runId: string }): React.JSX.Element {
  const [line, setLine] = useState("loading…");
  useEffect(() => {
    api
      .metrics(props.runId)
      .then((r) => {
        const m = r.metrics;
        const agents = Object.entries(m.perAgent)
          .map(([a, s]) => `${a} ${s.schemaValid}/${s.calls} valid`)
          .join(", ");
        setLine(
          `${m.calls} calls · ${m.tokensIn + m.tokensOut} tokens · ${m.schemaRepairs} repairs · ${m.transportRetries} retries · ${m.timeouts} timeouts · ${m.cacheHits} cache hits${agents ? ` · ${agents}` : ""}`,
        );
      })
      .catch(() => setLine("NO-LLM: no model calls on this run (deterministic core only)."));
  }, [props.runId]);
  return <p className="muted">{line}</p>;
}
