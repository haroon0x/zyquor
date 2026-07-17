# Plan 009 — Product Quality: UX gaps, quality evaluation, prompt quality

Executor: `codex exec -m gpt-5.6-sol -c model_reasoning_effort="xhigh"`. Same protocol as 006–008: dispatch → diff review → gates → commit direct to master.

| # | Task | Scope | Status |
|---|------|-------|--------|
| 9.1 | Jobs UX gaps: shuffled post-ready (docs promise shuffle, code is chronological), PATCH /jobs/:id to set/clear scheduledFor on non-running jobs | api, web | TODO |
| 9.2 | Surface quality-gate-failed drafts in UI: list them, show reason/threshold/slop phrase, allow retry or discard | api, web | TODO |
| 9.3 | Split packages/generation/src/index.ts (820 lines) into modules (prompts, quality, providers, config) preserving the public API | generation | TODO |
| 9.4 | Ollama LLM judge: evaluateTweetQuality via local model (gemma4:e4b), advisory scores stored on candidates, shown in UI. Never gates or decides posting — deterministic gate stays authoritative | generation, api, web | TODO |
| 9.5 | Prompt quality push: per-tweet-type few-shot exemplars, tightened anti-slop guidance; validate with scripts/tweet-harness.mjs before/after | generation | TODO |

Constraints carried from CLAUDE.md: LLM writes candidate text only; judge output is advisory display data, not a posting decision. Posting stays behind env flags, explicit and logged.
