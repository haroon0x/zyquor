# Plan 007 — Product next steps (post-desktop)

Executor: codex CLI (`codex exec`), models: `gpt-5.6-sol` medium reasoning for
scoped tasks, `gpt-5.6-terra` high reasoning for design-heavy tasks.
Orchestrated the same way as plan 006: dispatch → diff review → gates → commit.

Gates per task: `pnpm check`; touched-package tests (full suite is green as of
`e56ba07` except env-only browser failures on WSL); `pnpm smoke` where relevant.

## Task A — Source routing & quality (sol, medium)

From CLAUDE.md Next Steps. Deterministic routing, no LLM decisions:
- Job/hiring source items route to tweet type `hiring`; blog/feed items to
  `article_summary`; keep current default for the rest.
- Preserve source links and attribution in generated drafts (link must survive
  post-processing; attribution phrasing deterministic, not LLM-invented).
- Reduce generic framing: tighten the source-packet prompt so drafts reference
  concrete facts from the packet.
Scope: `packages/automation` (routing + packet drafting), `packages/adapters`
(item metadata needed for routing), prompt bits in `packages/generation`.
Tests: routing unit tests per source type; link-preservation test through
post-process.

## Task B — Reply drafting, stage 1: domain + storage (terra, high)

From CLAUDE.md Next Steps. Explicit reviewable jobs for reply tweets.
- `packages/core`: reply target on drafts/jobs — `replyTo: { tweetId, authorHandle, url }`
  (optional field), new tweet type already exists (`reply`).
- `packages/storage`: persist replyTo in sqlite + memory backends + mappers;
  migration-safe (existing rows readable).
- State machine: replies flow through the same draft→approve→job pipeline;
  no new statuses.
Tests: storage roundtrip both backends, schema validation.

## Task C — Reply drafting, stage 2: API + generation + UI (terra, high; after B)

- `POST /drafts` accepts optional replyTo; generation prompt gets reply context
  (target tweet text pasted by user; LLM still only writes candidate text).
- `packages/browser`: prepare flow opens the reply composer for the target
  tweet URL instead of the home composer (explicit, logged; post flag rules
  unchanged).
- Web UI: reply fields in the composer (target URL/handle), visible on job rows.
Tests: API accepts/validates replyTo; browser prepare gets a focused test with
mocked page.

## Task D — Worker durability (sol, medium; independent)

- Persist ingest-run state so an interrupted async ingest resumes or fails
  visibly instead of vanishing (attempt artifacts already exist for posting).
- Worker status panel in web UI: last heartbeat, last error, cycle counters
  (data already exposed by `/worker/status`; render it).

## Status

| Task | Status | Commit |
|------|--------|--------|
| A | DONE | see commit below |
| B | DONE | see commit below |
| C | TODO (needs B) | — |
| D | TODO | — |
