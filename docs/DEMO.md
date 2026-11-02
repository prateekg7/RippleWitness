# Demo script (2 minutes, PR-00 hero)

Setup (once):

```sh
corepack pnpm i && corepack pnpm demo:prepare
rm -rf /tmp/demo-subj && cp -r demo/shop-api /tmp/demo-subj && cd /tmp/demo-subj
git init -qb main && git add -A && git commit -qm base
git checkout -qb pr-00 && git apply <checkout>/demo/prs/PR-00.patch && git add -A && git commit -qm pr-00
ln -s <checkout>/demo/shop-api/node_modules node_modules
corepack pnpm dev   # in the RippleWitness checkout (server :4400, web :5173)
```

Beats (narration in quotes):

1. **Analyze (0:00–0:25).** New review: repo `/tmp/demo-subj`, base `main`,
   head `pr-00`, scenarios `<checkout>/demo/scenarios`. "The agent says it
   only touched checkout. We verify, not trust."
2. **Predict (0:25–0:55).** Static map shows checkout/orders impacted.
   Predict `POST /checkout` + `GET /orders`, lock. "Commit before the reveal —
   no anchoring."
3. **Reveal (0:55–1:25).** Miss: `GET /reports/sales` SURPRISE via the dormant
   `discount.applied` subscriber the static pass cannot see. "The ripple the
   map couldn't predict — caught by execution."
4. **Cross-exam + receipt (1:25–2:00).** Paste the agent summary, watch the
   SCOPE claim contradict; ask the SURPRISE question; issue the receipt and
   show the `RippleWitness-Receipt:` trailer. "Proof bound to this exact diff."

Fallbacks: no network/credits → same flow, assistants report NO-LLM (recorded
fixtures in tests). Replay failure → STATIC-ONLY with the gate disabled.
