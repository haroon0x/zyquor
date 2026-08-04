# Recovery branch review — fix list

Source: deep review of `recovery/opencode-2026-08-03` vs `master` (branch recovered from
uncommitted changes; nothing lost from master; 5-agent parallel review + verification).
Build passes; tests pass but only because of a fake-clock accident (see #10).

Status legend: `[x]` done — all items shipped and verified (full build + 235 tests green).

## Blockers

### [x] 1. `carriedOver` can permanently dead-lock ingestion — `packages/automation/src/ingest.ts:298-318`
Every `approved` autopost job, ever, account-wide, subtracts `carriedOver` from today's
`effectiveCap`. Posting is disabled by default, so jobs sit in `approved` forever and after
~6-10 the account's ingestion silently stops creating packets. Also counts tomorrow's jobs;
`carriedOver` is account-global while `todayPackets` is per-sourceType, so one config's backlog
zeroes another's quota.
Fix: count only approved autopost jobs created today (or scheduled within 24h) and cap
`carriedOver` at `target - 1`.

### [x] 2. Regenerate destroys the reviewed draft before the new one exists — `apps/api/src/routes/source-packets.ts:166-191`
`deleteDraft` + `resetSourcePacket` run before `draftFromSourcePacket`. If generation fails the
old draft is gone and the packet returns to `new` → the worker auto-drafts it as an autopost.
Also: `running` job → raw 500; an `approved` scheduled job is cascade-deleted without warning.
Fix: generate first; delete old draft / reset packet only after the new draft succeeds; on
failure keep the old draft. Block regenerate with 409 when a `running` job exists; surface when
an approved scheduled job is being replaced.

### [x] 3. Worker spins on post-gate 429 — `apps/worker/src/index.ts:365-367`
On "Too soon since the last post" the worker `continue`s silently. Job stays `approved` + due,
so it re-fires every ~5s poll for up to the gap window with no log, no attempt, no reschedule.
Fix: parse `nextEligibleAt` from the error message and PATCH the job's `scheduledFor` so the
poller skips until then; log at info.

## Majors

### [x] 4. Autopost hard-depends on a flaky local Ollama judge
- `apps/api/src/lib/quality-judge.ts:6-12` force-injects `ZYQUOR_LLM_PROVIDER: "ollama"`.
  Default setup is codex; without Ollama, yolo 503s and autopost degrades silently.
  Fix: honor the configured generation provider; judge failure should be a soft skip to the
  score floor, not a hard 503 / reject-all.
- `packages/automation/src/draft.ts:128` floor is 7 with a judge, 3 without — and a judge that
  *threw* still raises the floor to 7, converting "judge unavailable" into a full silent autopost
  shutoff. Fix: floor driven by env only, no `: 3` fallback, no judge-present boost.

### [x] 5. Daily-limit semantics silently changed — `apps/api/src/lib/daily-limit.ts`
`if (!dailyPostLimit) return false` (no limit → unlimited) removed; `ABSOLUTE_DAILY_POST_LIMIT`
15→4; variance defaults 10-12→3-4. Accounts with no limit are now hard-capped at 3-4/day and any
explicit limit above 4 is overridden by `Math.min`.
Fix (assumption — author to veto if the cap is intentional): restore the no-limit → unlimited
early return; keep the variance pacing for accounts that DO set a limit. Document the behavior.

### [x] 6. Strictness coin-flips in the generation lane — `packages/generation/src/refine.ts:96-97,126-129`
Empty insight (which the prompt explicitly invites) or an incomplete strict critique →
`READER_REJECTED_ALL` hard throw for every provider. `insightRequired: true` is now passed
universally. Fix: empty insight → fall back to non-insight generation; incomplete strict
critique → fall back to the unrevised output instead of rejecting everything.

### [x] 7. `hasEnoughSourceContext` weakened and promoted to a hard gate
- `packages/automation/src/context.ts:116-122`: was `facts >= 2 || (summary >= 90 && != title)`,
  now `facts >= 1 && != title`. Task spec (`tasks/x-feed-observations.md` §7) said keep it as-is.
  Fix: restore the master predicate.
- It now throws in `packages/automation/src/draft.ts:44` and 400s manual packet creation in
  `apps/api/src/routes/source-packets.ts`. Fix: don't hard-fail thin-context packets; skip them.

### [x] 8. Codex provider contract unverified + dead `--model` branch — `packages/generation/src/providers/codex.ts:29-44`
`--model` is only spliced in when `model !== DEFAULT_CODEX_MODEL`; desktop defaults to `luna`,
so the flag is never sent and codex uses the CLI's own default. No model allowlist validation.
Fix: always send `--model`; validate model (allowlist mirroring `safeCommandCodeModel`);
stat output size before read. Real smoke-test against the codex CLI required before merge.

### [x] 9. Off-topic filter vetoes mixed content — `packages/automation/src/ingest.ts:99-103,339-342`
One `OFF_TOPIC_TERMS` hit ("crypto", "climate", "nuclear", "gdp") kills an item before core
terms are checked; "AI startup" + a crypto mention is dropped. Fix: reject only when the item has
off-topic hits AND no core-term hits (mixed content with a core hit is kept).

## Hardening (minimal, high-value)

### [x] 10. Test gate is green by clock accident — `apps/api/src/app.test.ts`
Tests inject a fake clock (April) while the gate reads `new Date()` (real clock), so the 30-min
gate never fires and the suite doesn't exercise it. Fix: stub `ZYQUOR_POST_GAP_MIN_MINUTES=0` in
the API test setup so the gate is deterministically disabled and the suite exercises real logic.

### [x] 11. Web/desktop nits
- `apps/web/src/views/System.tsx:257` — "Automated posting" toggle not gated on `isDesktop`; in
  web-only mode `POST /system/posting` no-ops on `autoApproveSourcePackets`. Disable it there.
- `apps/desktop/src/main.ts:394` — `did-fail-load` handler ignores `isMainFrame`; a subframe
  failure replaces the whole UI with the error page. Guard on `isMainFrame`.
- `apps/desktop/tsconfig.json` — main `tsconfig.json` compiles `src/preload.ts` to ESM, then the
  preload tsconfig overwrites it as CJS. Exclude `src/preload.ts` from the main build.
- `apps/web/src/components/SourcePacketsPanel.tsx` — clear `feedbackDraft[packet.id]` after save
  so stale un-trimmed text doesn't shadow the server value.
- `apps/web/src/types.ts` — `SourcePacket.feedback` should be optional; add
  `feedbackDir` / `autoApproveSourcePackets` to `DesktopSettingsData`.

### [x] 12. Generation hardening
- `packages/generation/src/providers/http.ts:17-21` — far-future rate-limit reset returns 0ms
  backoff → instant retry into a closed window. Never return 0; cap at MAX_BACKOFF_MS.
- `packages/generation/src/evaluator.ts:143-147` — legacy judge path leaves `pass: undefined`,
  silently failing the yolo/autopilot gate. Default `pass` from the score in the legacy path.
- `packages/generation/src/quality.ts:58` — `\b(?:more options|more things|...)\b` slop pattern
  has high false positives. Remove or constrain it; clamp quality min/max to [0,10].
- `packages/generation/src/prompts.ts:32` — `\bzyquo(?:r|er)\b` typo in the slop regex.

## Config / docs

### [x] 13. Env + docs coherence
- `.env.example` — add `ZYQUOR_DAILY_PACKET_MIN` / `ZYQUOR_DAILY_PACKET_MAX` (used in
  `packages/automation/src/ingest.ts:262`, missing from example).
- `docs/development.md:181` — still says default provider is `command-code` /
  `deepseek/deepseek-v4-pro`; everywhere else it's `codex`/`luna`. Fix one sentence.
- `.gitignore` — add `/feedback` (feedback-notebook writes `feedback/notebook.md` to cwd).