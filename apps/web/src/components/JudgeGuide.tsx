import React from "react";

export type GuideStage = "start" | "loading" | "predict" | "revealed" | "static-only" | "failed";

/** Plain-language meaning of every fused status shown in the blast map. */
export const STATUS_HELP: Record<string, string> = {
  CONFIRMED: "Code analysis predicted this could change, and execution confirmed that it did. This is an expected ripple.",
  CLEARED: "Code analysis flagged this as reachable, but old-vs-new execution showed no change. You can drop this worry.",
  SURPRISE: "Behavior changed even though code analysis found no path from the edit. Investigate this first; it may reveal a hidden coupling.",
  UNVERIFIED: "This might be affected, but no scenario exercised it. Treat it as an open coverage gap—not as a pass.",
  QUIET: "No static connection was found and execution did not change it. Hidden by default after reveal to reduce noise.",
  DIFF: "The change itself added or removed this route or function.",
  CONTRADICTED: "A claim about this item was disproved by execution evidence.",
  CHANGED: "In a dynamic-only run, replay observed a behavior change. No static prediction was available.",
  UNCHANGED: "In a dynamic-only run, replay exercised this item and observed no change.",
  UNCOVERED: "In a dynamic-only run, this item was never exercised.",
};

const FEATURE_GUIDE: { name: string; needs: string; use: string }[] = [
  {
    name: "Blast map and prediction gate",
    needs: "Before the reveal, your judgment: tick each route you expect to change. Tick “Nothing else changes” only if you also claim every unticked route will stay the same. Then lock the prediction.",
    use: "Turn a vague code review into a testable prediction. After locking, execution grades what you caught, what you missed, and which worries were unnecessary.",
  },
  {
    name: "Diff",
    needs: "Your normal code-reading attention. Move hunk by hunk and compare the old and new code.",
    use: "Understand exactly what the author changed. The blast map then adds what static analysis predicts and what execution actually observed beyond the edited lines.",
  },
  {
    name: "Gate score and missed routes",
    needs: "No new input after locking. If you intentionally override a failed gate, it asks for a written reason.",
    use: "Recall tells you how many truly changed routes you caught; precision tells you how many of your predictions were right. The missed-route table explains whether the gap came from coverage, static blindness, or your prediction.",
  },
  {
    name: "Auto-forge coverage",
    needs: "One click when routes remain UNVERIFIED. It may take time while candidate probes are replayed.",
    use: "Generate additional safe probes for uncovered routes. Only probes that behave deterministically are kept, so more of the map can move from “unknown” to observed evidence.",
  },
  {
    name: "Agent claims",
    needs: "Paste the coding agent’s final summary, then choose “Extract + verify claims.”",
    use: "Split the agent’s story into checkable statements and compare each one with replay evidence. SUPPORTED means evidence agrees; CONTRADICTED means it disagrees; UNVERIFIABLE means there is not enough evidence either way.",
  },
  {
    name: "Questions for the agent",
    needs: "Choose “Ask agent” on an open question. If no live agent session is linked, leave the question open rather than treating silence as an answer.",
    use: "Send the agent a question together with the concrete evidence that raised it. Its reply is extracted and checked again: RESOLVED means the reply holds up; CONTESTED means it still conflicts with the evidence.",
  },
  {
    name: "Receipt",
    needs: "Choose “Issue receipt” when you want a portable record of the completed review.",
    use: "Create a signed, tamper-evident record tied to the exact code versions and scenario suite. L3 means full static-plus-replay evidence, L2 means replay without static claims, and L0 means static-only because replay failed. A receipt proves what was observed—not that the code is universally correct.",
  },
  {
    name: "Canary",
    needs: "A file to mutate, then choose “Arm canary.” The mutation is planted only in a disposable copy; it never writes to the repository being reviewed.",
    use: "Test reviewer attention with a deliberate fake bug. ACCEPTED means execution proved the planted change alters behavior, so a careful reviewer could catch it. REJECTED means the mutation had no observable effect and was discarded. Arm one, then see whether the reviewer flags it during review.",
  },
  {
    name: "Blind-first review",
    needs: "Your own finding first, written as file:start-end plus a note. Only after that should you run the AI reviewer.",
    use: "Form an independent judgment before AI suggestions can anchor you. Then compare your finding with the AI’s findings instead of starting from them.",
  },
  {
    name: "Summary",
    needs: "One click; it should be based on the diff and observations, not on the agent’s self-description.",
    use: "Get an evidence-grounded PR title and a reminder of routes that remain unverified, so uncertainty is visible instead of polished away.",
  },
  {
    name: "Predict-then-run",
    needs: "A function identifier, JSON arguments, and your predicted output for both the base and head versions.",
    use: "Make a small, precise prediction and have execution grade it. This is useful when a helper or ML function matters more than an HTTP route.",
  },
  {
    name: "Causal ablation",
    needs: "The ID of a changed route, then choose Plan and run one proposed ablation.",
    use: "Test whether a suspected shared helper, event, table, or other coupling actually causes an unexpected change. If neutralizing the coupling makes the difference disappear, the cause is confirmed by intervention—not just correlation.",
  },
  {
    name: "Model usage",
    needs: "Nothing. This is read-only transparency information.",
    use: "Audit how much model help was used: calls, tokens, schema repairs, retries, cache hits, and fallbacks. Scores and verdicts are computed in code; model output never decides them.",
  },
];

function actionsFor(stage: GuideStage, hosted: boolean): string[] {
  switch (stage) {
    case "start":
      return hosted
        ? [
            "Do not enter parameters: this hosted example is already fixed to a real json-server change.",
            "Press Analyze, or open the recorded run listed below the form.",
            "On the next screen, inspect the blast map and lock your prediction before looking for the verdicts.",
          ]
        : [
            "Provide the subject repository, the base and head refs, and a scenarios directory, then press Analyze.",
            "Wait for static analysis and replay to finish.",
            "On the run screen, make and lock a prediction before the execution results are revealed.",
          ];
    case "loading":
      return [
        "Wait while RippleWitness builds the code graph and replays scenarios against the old and new versions.",
        "When the blast map appears, do not look for final verdicts yet—first make the prediction described below.",
      ];
    case "predict":
      return [
        "Use Static to see what the code graph can reach and Exercised to see what a scenario actually ran.",
        "Tick “Will change?” for every route you expect to behave differently.",
        "Tick “Nothing else changes” only if that stronger claim is intentional, then press Lock prediction.",
      ];
    case "revealed":
      return [
        "Start with SURPRISE and CONTRADICTED rows; they are the highest-signal warnings.",
        "Next inspect UNVERIFIED rows. They are unknowns to close, not successful checks.",
        "Use the feature guide below to challenge claims, question the agent, test attention with a canary, and issue a receipt.",
      ];
    case "static-only":
      return [
        "Replay failed, so the prediction gate is disabled and no execution verdict should be inferred.",
        "Use the diff and static map only as hypotheses about possible impact.",
        "Correct the subject’s run setup outside this panel, then create a fresh analysis.",
      ];
    case "failed":
      return [
        "This analysis did not complete; do not treat the absence of warnings as evidence.",
        "Return to New review and check the repository, refs, scenarios, and start command.",
      ];
  }
}

export function JudgeGuide(props: { stage: GuideStage; hosted?: boolean }): React.JSX.Element {
  const actions = actionsFor(props.stage, props.hosted ?? false);
  return (
    <aside className="judge-guide" aria-labelledby="judge-guide-title">
      <h2 id="judge-guide-title">Judge &amp; user guide</h2>
      <p>
        RippleWitness asks a reviewer to <strong>predict</strong> what a change will affect, then checks that
        prediction by running scenarios against both the old and new code. A normal diff shows what was edited;
        this tool tests how far the edit actually ripples.
      </p>

      <div className="guide-block">
        <h3>Do this now</h3>
        <ol>
          {actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      </div>

      <div className="guide-block">
        <h3>How to judge the result</h3>
        <ul>
          <li>Good evidence separates <strong>predicted</strong>, <strong>observed</strong>, and <strong>unknown</strong>.</li>
          <li>A changed route with no predicted path is more important than a long list of edited lines.</li>
          <li>An agent saying “nothing else changed” is a claim to test, never evidence by itself.</li>
          <li>Unknowns stay visible as UNVERIFIED instead of being silently treated as safe.</li>
        </ul>
      </div>

      <div className="guide-block">
        <h3>Terms used in the blast map</h3>
        <dl className="guide-terms">
          <dt>Static</dt>
          <dd>The code graph says changed code can reach this route. It is a prediction source, not proof.</dd>
          <dt>Exercised</dt>
          <dd>A scenario actually ran this route against the relevant versions.</dd>
          {Object.entries(STATUS_HELP).map(([term, meaning]) => (
            <React.Fragment key={term}>
              <dt>{term}</dt>
              <dd>{meaning}</dd>
            </React.Fragment>
          ))}
        </dl>
      </div>

      <div className="guide-block">
        <h3>What each feature wants from you—and what you get</h3>
        {FEATURE_GUIDE.map((feature) => (
          <article className="guide-feature" key={feature.name}>
            <h4>{feature.name}</h4>
            <p><strong>Wants from you:</strong> {feature.needs}</p>
            <p><strong>Use it to:</strong> {feature.use}</p>
          </article>
        ))}
      </div>

      <p className="guide-note">
        Rule of thumb: CONFIRMED and CLEARED close predicted worries, SURPRISE opens an investigation, and
        UNVERIFIED asks for more coverage. Verdicts and scores are computed in code, never decided by the model.
      </p>
    </aside>
  );
}
