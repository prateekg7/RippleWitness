# Submission checklist (Indie track)

Source of truth: the Official Rules + submission portal (see `docs/spikes/S-04.md`
for what is confirmed vs still open). Do not submit until every box is checked
against the portal clock.

- [ ] Submit ≤ 03:00 IST 5 Nov 2026 (safe under both deadline readings).
- [ ] Public repo link; team members added; track = Indie.
- [ ] Demo video (2 min, beats in `docs/DEMO.md`); shows only work done during
      the event window (net-new rule, secondary source — confirm in Rules).
- [ ] Description: novelty sentence from PRD §11 only; numbers only from
      `eval/results.md`; limitations from `docs/real-repo-run.md`
      (remaining limitations) and `AUDIT.md` §7 (author-local, not in repo).
- [ ] Third-party/OSS disclosure per the Rules format (all deps are pinned in
      `pnpm-lock.yaml`; no vendored code).
- [ ] AI-assistance disclosure per the Rules format (built with Muse Code;
      agent runs reused from the session store per AGENTS §A5b).
- [ ] `META_API_KEY` and `.ripplewitness/key` never committed (`.gitignore`);
      `.env.example` has names only.
- [ ] Fresh-clone check: `corepack pnpm i && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test`.
