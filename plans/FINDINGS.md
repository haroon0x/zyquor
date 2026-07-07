# Audit Findings — 2026-06-12 (partial)

Recorded at commit `91f3988` with a dirty working tree (uncommitted changes in
`packages/generation/src/index.ts`, `index.test.ts`, `packages/storage/src/memory.ts`,
`packages/storage/src/sqlite.ts`, `CLAUDE.md`, `docs/development.md`,
`scripts/open-x-profile-cdp.mjs`).

**Coverage caveat:** this was a single-session pass, not a full audit. The
findings below come from direct reading of `packages/generation/*`,
`packages/automation/*` (draft/quality/selection), `packages/generation/src/harness.ts`,
parts of `apps/api/src/app.test.ts`, root config, and test-suite runs.
**Not audited at all:** `apps/api/src/app.ts` (1487 lines), `apps/web/src/main.tsx`
(1310 lines), `packages/storage` internals, `packages/browser`, `packages/adapters`,
`apps/worker`, `scripts/*.mjs`, and the security category generally. A follow-up
audit should cover those before any large refactor.

## Verified findings

### [TESTS-01] Date-sensitive API test breaks the verification baseline

- **Evidence**: `apps/api/src/app.test.ts:828-858` — "purges posted tweet history after 24 hours" mocks `Date.now` to 2026-04-24 and expects `POST /jobs/:id/post` → 200, but receives 409. Confirmed failing at clean HEAD `91f3988` (not caused by working-tree changes); 36/37 other api tests pass.
- **Impact**: `pnpm test` is red on master, so no change can be verified green. Every future agent/PR loses its baseline. The 409 implies some posting precondition (daily limit, schedule window, job state) reads time or state not covered by the `Date.now` mock.
- **Effort**: S–M (investigation first; fix is likely small).
- **Risk**: LOW — test-only or clock-injection fix; posting logic itself stays.
- **Confidence**: HIGH that the baseline is broken; cause not yet diagnosed.
- **Fix sketch**: see `plans/001-fix-date-sensitive-history-test.md`.

### [DEBT-01] Dead "viral" generation modules contradict the current prompt direction

- **Evidence**: `packages/generation/src/viral-generation.ts` (240 lines) and `packages/generation/src/viral-prompt.ts` (127 lines) are re-exported from `packages/generation/src/index.ts` (bottom of file: `export * from "./viral-prompt.js"` etc.) but `grep -rn "viral"` across `apps/*/src` and other packages returns zero importers.
- **Impact**: 367 lines of unmaintained prompt code full of hook-formula patterns ("Unpopular opinion:", "Hot take:", CONTENT_STYLE menus) that the 2026-06-12 prompt rewrite deliberately removed and now hard-rejects via `GENERIC_SLOP_PATTERNS`. If anyone wires these in later, output quality regresses instantly.
- **Effort**: S.
- **Risk**: LOW — no importers.
- **Confidence**: HIGH.
- **Fix sketch**: see `plans/002-delete-dead-viral-generation-code.md`.

### [DX-01] No CI at all

- **Evidence**: no `.github/` directory in repo root; `package.json` has working `pnpm test` / `pnpm check` scripts that are only ever run by hand.
- **Impact**: regressions land silently (TESTS-01 and DEBT-02 both happened exactly this way: code changed, tests not run). For a repo developed largely by agents, an automated gate is the single highest-leverage guard.
- **Effort**: S.
- **Risk**: LOW.
- **Confidence**: HIGH.
- **Fix sketch**: see `plans/003-add-ci-workflow.md`.

### [DEBT-02] OpenRouter model allowlist drifts across code, tests, and docs

- **Evidence**: working tree changed `OPENROUTER_MODELS` in `packages/generation/src/index.ts:54-68` (default now `openrouter/owl-alpha`; `minimax/*`, `tencent/*`, `inclusionai/*` removed) without updating `index.test.ts` (5 tests failed; fixed in this session) or `CLAUDE.md` ("Preferred provider is OpenRouter with free models (nvidia/nemotron-3-super..., minimax/minimax-m2.5:free, tencent/hy3-preview:free)" — now stale and actively wrong).
- **Impact**: agents reading CLAUDE.md will configure removed models; `ZYQUOR_OPENROUTER_MODEL` set to a documented-but-delisted model silently coerces to the default, which is confusing to debug.
- **Effort**: S.
- **Risk**: LOW.
- **Confidence**: HIGH.
- **Fix sketch**: see `plans/004-align-model-list-docs.md`.

### [DEBT-03] Dual repository implementations (sqlite + memory) must be edited in lockstep

- **Evidence**: `packages/storage/src/sqlite.ts` (989 lines) and `packages/storage/src/memory.ts` (653 lines) implement the same `ZyquorRepository` surface; both are modified together in the current working tree; both have churn count 8 since March.
- **Impact**: every storage feature is written twice; divergence between the two is a standing bug source and the JSON fallback is what runs when `node:sqlite` is unavailable.
- **Effort**: M–L to consolidate (shared core + thin persistence drivers) — needs a real audit of both files first.
- **Risk**: MED — storage touches everything.
- **Confidence**: MED (size/churn signal read; internals not audited).
- **Fix sketch**: not planned yet — audit `packages/storage` first. Recorded so it isn't lost.

### [SECURITY-01] Automated lane: scraped content flows into auto-approved posts with regex-only gating

- **Evidence**: `packages/automation/src/draft.ts:76-95` — `autoApprove` path takes `candidates[0]`, runs `validateSourcePostQuality` (`packages/automation/src/quality.ts:80-100`, pure regex/URL/cooldown checks), then `approveDraft({ mode: "autopost" })`. Source packet text (title/summary/facts) comes from scraped external feeds and is interpolated into the LLM prompt (`packages/generation/src/harness.ts:42-51`).
- **Impact**: a malicious or compromised feed item can steer the LLM into posting attacker-chosen text on the user's real X account; the quality gate catches format problems, not adversarial content.
- **Effort**: M for meaningful hardening (instruction/data separation in prompt, content allowlist heuristics, per-source trust tiers, keeping autopost off for new sources).
- **Risk**: LOW for additive checks.
- **Confidence**: MED-HIGH — flow read end to end this session; no exploit demonstrated.
- **Fix sketch**: not planned yet; deserves its own design pass. Mitigation today: keep `ZYQUOR_ENABLE_BROWSER_POST=0` default (already the case) and prefer review lane for newly added sources.

### [DIRECTION] (from CLAUDE.md "Next Steps" — stated intent, not yet planned here)

1. **Generation quality feedback loop** — `GET /history/analysis` exists but nothing routes its output (or real example tweets) back into prompts. The style-profile `systemPromptExtra` field is already wired into `systemPrompt()`; populating it with 5–10 of the user's real tweets is the cheapest large win for authenticity. See `plans/005-style-profile-few-shot-spike.md`.
2. **Reply drafting** — `reply` tweet type exists in prompts/types, but no reply-target tracking (tweet ID, author) exists anywhere. Stated in CLAUDE.md Next Steps.
3. **Worker durability** — CLAUDE.md Next Steps names durable async stages and a worker UI panel.
4. **Maintainability split** of `app.ts` / `main.tsx` — already in CLAUDE.md Next Steps; needs a real audit to find the seams before planning.

## Findings considered and rejected

- "Broken pnpm symlink (`~/.local/bin/pnpm` → removed Hermes node)" — environment issue, not a repo defect; fixed in-session and already documented in CLAUDE.md's pnpm setup section.
