# Bug log
| ID | Sev | Status | Component | Summary | Found by | Fix commit | Regression test |
|----|-----|--------|-----------|---------|----------|------------|-----------------|
| BUG-001 | S0 | fixed | server | Reveal returned empty questions (read never-written artifact) | E2E-01 | Epic L | predict.int reveal-includes-questions |
| BUG-002 | S1 | fixed | server | Prod server never wired claim extractor (503 with key set) | L-01 audit | Epic L | serve.test buildLlmOptions |
| BUG-003 | S0 | fixed | replay | Compute + harvest subprocesses inherited the server env (incl. `META_API_KEY`) via execa defaults | N-02 review | uncommitted | compute-env.test (secret invisible to subject fn) |
| BUG-004 | S1 | fixed | server | Miss-cause taxonomy dead in prod: predict rebuilt evidence without `impactPath`, so every miss was `implicit_contract` | N-02 review | uncommitted | predict.int gate-scoring-causes |
| BUG-005 | S1 | fixed | receipt | Receipts bound ref spellings (`main`), failing CI verification in SHA-only clones; now bind resolved SHAs | O-01 real-repo run | uncommitted | receipts.test binds-resolved-SHAs + ci-action VALID on json-server |
| BUG-006 | S2 | fixed | replay | `ensureDeps` used `unlinkSync` on `node_modules`; subjects that commit a real deps dir failed replay (EPERM) | O-02 forge run | uncommitted | deps.test replaces-committed-node_modules |
| BUG-007 | S2 | fixed | docs | DEMO.md copied the subject including `node_modules`, nesting the later symlink and breaking module resolution | O-02 forge run | uncommitted | DEMO.md excludes deps from copy (flow re-verified live) |
