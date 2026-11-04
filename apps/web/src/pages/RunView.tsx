import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { MapNode, Reveal } from "../api.js";
import { JudgeGuide, STATUS_HELP } from "../components/JudgeGuide.js";

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

/** Turn API error codes into judge-readable guidance instead of raw HTTP JSON. */
function friendlyError(err: unknown): string {
  const raw = String(err);
  if (raw.includes("gate_not_passed")) return "Receipt blocked: the prediction gate has not passed. Record an override reason under Gate score, then issue the receipt.";
  if (raw.includes("prediction_locked_required")) return "Lock your prediction first — this unlocks after the gate.";
  if (raw.includes("human_findings_required_first")) return "Submit your own finding first — AI review unlocks only after that (blind-first).";
  if (raw.includes("no_llm")) return "Unavailable on this deployment: no Meta model is configured (META_API_KEY missing). Your input above is still recorded; the deterministic review continues without it.";
  if (raw.includes("agent_unavailable")) return "No live agent answered. Locally, make sure the muse CLI is on PATH; the hosted demo answers through a labeled stub instead.";
  if (raw.includes("rate_limited")) return "Rate limit reached on this hosted demo. Wait a few minutes and try again.";
  if (raw.includes("file_not_in_head")) return "That file is not in the head version of this change. Pick a file shown in the Diff above.";
  if (raw.includes("no_mutation_applies")) return "No canary mutation applies to that file. Try another changed file from the Diff.";
  if (raw.includes("question_quota_exhausted")) return "Question quota for this review is used up (5 asked questions).";
  return raw.replace(/^Error: /, "");
}

/** Answers are stored as JSON ({text, mode, followup}); render them readably. */
function formatAnswer(answer: string): string {
  try {
    const parsed = JSON.parse(answer) as { text?: string; mode?: string; followup?: string | null };
    if (typeof parsed.text !== "string") return answer;
    const modeLabel =
      parsed.mode === "live_session"
        ? "live agent session"
        : parsed.mode === "reinstantiated_from_transcript"
          ? "re-instantiated from transcript / demo stub"
          : parsed.mode ?? "agent";
    return `A (${modeLabel}): ${parsed.text}${parsed.followup ? `\n${parsed.followup}` : ""}`;
  } catch {
    return `A: ${answer}`;
  }
}

function StatusPill(props: { status: string }): React.JSX.Element {
  const glyph = STATUS_GLYPH[props.status] ?? "▪";
  return (
    <span className={`pill ${props.status.toLowerCase()}`} title={STATUS_HELP[props.status] ?? props.status}>
      <span aria-hidden="true">{glyph} </span>
      {props.status}
    </span>
  );
}

function StatusLegend(): React.JSX.Element {
  return (
    <p className="muted">
      {Object.entries(STATUS_GLYPH).map(([s, g]) => `${g} ${s}`).join(" · ")}
      {" "}— definitions are in the side guide; hover any status pill for its meaning.
    </p>
  );
}

function AssistantsBox(props: { runId: string }): React.JSX.Element {
  const [file, setFile] = useState("");
  const [startLine, setStartLine] = useState("");
  const [endLine, setEndLine] = useState("");
  const [note, setNote] = useState("");
  const [recorded, setRecorded] = useState(false);
  const [busyAi, setBusyAi] = useState(false);
  const [out, setOut] = useState("");
  const [aiOut, setAiOut] = useState<string[]>([]);
  return (
    <div>
      <p className="muted">Step 1: record your own finding (file and line range from the Diff, plus what to check). Step 2: only then run AI review, so its findings cannot anchor yours.</p>
      <input type="text" value={file} onChange={(e) => setFile(e.target.value)} placeholder="file, e.g. src/app.ts" />
      <input type="text" value={startLine} onChange={(e) => setStartLine(e.target.value)} placeholder="start line, e.g. 40" inputMode="numeric" />
      <input type="text" value={endLine} onChange={(e) => setEndLine(e.target.value)} placeholder="end line, e.g. 44" inputMode="numeric" />
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="your finding, e.g. check the 404 response shape" />
      <button
        onClick={() => {
          const start = Number(startLine);
          const end = Number(endLine);
          if (!file.trim() || !note.trim() || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
            setOut("Fill file, a valid line range (start ≤ end), and your finding note first.");
            return;
          }
          void api.findings(props.runId, [{ file: file.trim(), startLine: start, endLine: end, note: note.trim() }])
            .then((r) => { setRecorded(true); setOut(`Your finding is recorded (${r.recorded}). AI review is now unlocked.`); })
            .catch((e: unknown) => setOut(friendlyError(e)));
        }}
      >
        Submit finding
      </button>{" "}
      <button
        className="secondary"
        disabled={!recorded || busyAi}
        title={recorded ? "Run the AI reviewer now" : "Submit your own finding first"}
        onClick={() => {
          setBusyAi(true);
          void api.aiReview(props.runId)
            .then((r) => {
              setAiOut([
                `${r.valid.length} valid finding(s), ${r.rejected.length} rejected as not grounded in the diff.`,
                ...r.valid.map((f) => `${f.file}:${f.startLine}-${f.endLine} [${f.severity}] ${f.note}`),
              ]);
            })
            .catch((e: unknown) => setAiOut([friendlyError(e)]))
            .finally(() => setBusyAi(false));
        }}
      >
        {busyAi ? "Reviewing…" : "Run AI review"}
      </button>
      {!recorded && <p className="muted">AI review stays locked until your finding is recorded.</p>}
      {out && <p>{out}</p>}
      {aiOut.length > 0 && (
        <div>
          {aiOut.map((line) => <p key={line}>{line}</p>)}
        </div>
      )}
    </div>
  );
}

function SummaryBox(props: { runId: string }): React.JSX.Element {
  const [out, setOut] = useState("");
  return (
    <div>
      <button onClick={() => void api.summary(props.runId).then((r) => setOut(`${r.summary.title} — unverified: ${r.summary.unverified.join(", ") || "none"}`)).catch((e: unknown) => setOut(friendlyError(e)))}>Write summary</button>
      {out && <p>{out}</p>}
    </div>
  );
}

function ReceiptBox(props: { runId: string; canIssue: boolean; blockedReason?: string }): React.JSX.Element {
  const [trailer, setTrailer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      {!props.canIssue && props.blockedReason && <p className="muted">{props.blockedReason}</p>}
      <button
        disabled={busy}
        onClick={() => {
          if (!props.canIssue) { setError(props.blockedReason ?? "Receipt is not available yet."); return; }
          setBusy(true);
          void api.receipt(props.runId)
            .then((r) => { setTrailer(r.trailer); setError(""); })
            .catch((e: unknown) => setError(friendlyError(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Issuing…" : "Issue receipt"}
      </button>
      {trailer && <p className="muted">Issued and stored for this run: {trailer}</p>}
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
      <p className="muted">Canary = a deliberate fake bug used to test reviewer attention. Arming plants a subtle mutation in a throwaway copy (never your repo) and keeps it only if execution proves it changes behavior. ACCEPTED = a valid canary a careful reviewer could catch — hide it among the hunks and see if it gets flagged. REJECTED = the mutation changed nothing observable, so it was discarded. Pick the file to mutate, then arm.</p>
      <input type="text" value={file} onChange={(e) => setFile(e.target.value)} />
      <button disabled={busy} onClick={() => { setBusy(true); void api.canary(props.runId, file).then((r) => setResult(`${r.verdict.accepted ? "ACCEPTED" : "REJECTED"} ${r.candidate.operator} @${r.candidate.file}:${r.candidate.line} — ${r.verdict.reason}`)).catch((e: unknown) => setResult(friendlyError(e))).finally(() => setBusy(false)); }}>
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
  const [askBusyId, setAskBusyId] = useState<string | null>(null);
  const [askErrors, setAskErrors] = useState<Record<string, string>>({});

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

  const toggle = (r: string): void => {
    setNothingElse(false);
    setSelected((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]));
  };
  const toggleNothingElse = (checked: boolean): void => {
    setNothingElse(checked);
    if (checked) setSelected([]);
  };

  if (status === "loading" || status === "running")
    return (
      <div className="guide-layout">
        <div className="guide-content"><section><h2>Analyzing…</h2><p className="muted">graph + replay running</p></section></div>
        <JudgeGuide stage="loading" />
      </div>
    );
  if (status === "static-only")
    return (
      <div className="guide-layout">
        <div className="guide-content"><section><h2>Static only</h2><p className="error">Replay failed; the gate is disabled. Diff and static map still available.</p></section></div>
        <JudgeGuide stage="static-only" />
      </div>
    );
  if (status === "failed")
    return (
      <div className="guide-layout">
        <div className="guide-content"><section><h2>Failed</h2><p className="error">Analysis failed.</p></section></div>
        <JudgeGuide stage="failed" />
      </div>
    );

  return (
    <div className="guide-layout">
      <div className="guide-content">
      {error && <section><p className="error">{error}</p></section>}
      <section>
        <h2>Blast map {locked ? "(revealed)" : "(predict first)"}</h2>
        {!locked && (
          <p className="muted">
            Your only input, in two mutually exclusive forms: either tick <strong>Will change?</strong> for each
            route you expect to behave differently, or tick <strong>Nothing changes at all</strong> if you expect
            zero routes to change. Then press <strong>Lock prediction</strong>. Outcomes stay hidden until you commit.
          </p>
        )}
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
                  <td><input type="checkbox" checked={selected.includes(n.routeId)} disabled={nothingElse} onChange={() => toggle(n.routeId)} aria-label={n.routeId} /></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!locked && (
          <div style={{ marginTop: 8 }}>
            <label><input type="checkbox" checked={nothingElse} onChange={(e) => toggleNothingElse(e.target.checked)} /> Nothing changes at all (no route will change)</label>
            <button onClick={() => void api.predict(runId, { routeIds: selected, nothingElse }).then(refresh).catch((e: unknown) => setError(friendlyError(e)))}>Lock prediction</button>
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
            <p className="muted">Your prediction, graded by execution. Recall = of the routes that really changed, how many you caught. Precision = of your predictions, how many were right. PASSED needs both at the bar; override only with a recorded reason.</p>
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
                <button className="secondary" disabled={!override.trim()} onClick={() => void api.override(runId, override.trim()).then(refresh).catch((e: unknown) => setError(friendlyError(e)))}>Override with reason</button>
                <p className="muted">A recorded override is also what unblocks the receipt below when the gate has not passed.</p>
              </div>
            )}
            {reveal.overrideReason && <p className="muted">Overridden: {reveal.overrideReason}</p>}
            <AutoForgeBox runId={runId} refresh={refresh} />
          </section>

          <section>
            <h2>Agent claims ({reveal.claims.length})</h2>
            <p className="muted">What the agent said about its own change, checked against replay: SUPPORTED = evidence agrees · CONTRADICTED = evidence disagrees · UNVERIFIABLE = no evidence (not the same as false).</p>
            {reveal.claims.length === 0 && <p className="muted">No claims extracted. Paste the agent summary below (needs META_API_KEY).</p>}
            <table>
              <tbody>
                {reveal.claims.map((c) => (
                  <tr key={c.claimId}><td>{c.type}</td><td>{c.text}</td><td>{c.verdict}</td></tr>
                ))}
              </tbody>
            </table>
            <textarea rows={3} value={agentText} onChange={(e) => setAgentText(e.target.value)} placeholder="Agent final summary…" />
            <button onClick={() => void api.agentMessage(runId, agentText).then(refresh).catch((e: unknown) => setError(friendlyError(e)))}>Extract + verify claims</button>
          </section>

          <section>
            <h2>Receipt</h2>
            <p className="muted">A signed, tamper-evident record of this exact diff and scenario suite. It proves what was observed (and at which assurance tier, L0–L3), not that the code is correct. Verify it later with the CI action.</p>
            <ReceiptBox
              runId={runId}
              canIssue={reveal.score.passed || Boolean(reveal.overrideReason)}
              blockedReason="Receipt is blocked until the gate passes — or you record an override reason under Gate score above. That keeps a failed prediction from being silently receipted."
            />
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
            <p className="muted">Evidence-anchored questions raised by contradictions and surprises. Ask agent sends the question with its evidence to the agent (read-only); its reply is re-checked: RESOLVED = reply&apos;s claims hold, CONTESTED = they still conflict, OPEN/ASKED = awaiting an answer.</p>
            {reveal.questions.length === 0 && <p className="muted">No questions were generated for this run. Questions appear when replay contradicts a claim or finds a surprise.</p>}
            {reveal.questions.map((q) => (
              <div key={q.id} style={{ borderTop: "1px solid #16130e", padding: "6px 0" }}>
                <p><strong>[{q.template}]</strong> {q.text} <span className="muted">({q.status})</span></p>
                {q.answer && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{formatAnswer(q.answer)}</p>}
                {(q.status === "OPEN" || q.status === "ASKED") && (
                  <button
                    className="secondary"
                    disabled={askBusyId === q.id}
                    onClick={() => {
                      setAskBusyId(q.id);
                      setAskErrors((prev) => ({ ...prev, [q.id]: "" }));
                      void api.ask(runId, q.id)
                        .then(refresh)
                        .catch((e: unknown) => setAskErrors((prev) => ({ ...prev, [q.id]: friendlyError(e) })))
                        .finally(() => setAskBusyId(null));
                    }}
                  >
                    {askBusyId === q.id ? "Asking…" : "Ask agent"}
                  </button>
                )}
                {askErrors[q.id] && <p className="error">{askErrors[q.id]}</p>}
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
      </div>
      <JudgeGuide stage={locked ? "revealed" : "predict"} />
    </div>
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
      <p className="muted">Coverage gap? Auto-forge writes probe scenarios for UNVERIFIED routes and keeps only ones that replay identically twice, then the statuses recompute.</p>
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
          `${m.calls} calls · ${m.tokensIn + m.tokensOut} tokens · ${m.schemaRepairs} repairs · ${m.transportRetries} retries · ${m.timeouts} timeouts · ${m.cacheHits} cache hits · ${m.fallbackCalls} fallbacks${agents ? ` · ${agents}` : ""}`,
        );
      })
      .catch(() => setLine("NO-LLM: no model calls on this run (deterministic core only)."));
  }, [props.runId]);
  return <p className="muted">{line}</p>;
}
