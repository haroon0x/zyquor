# Quality & Spacing Implementation Plan

**Goal:** Hard quality floor for autopost + high-variance randomized post spacing (30–90 min, anti-cluster), so the auto worker pipeline only produces varied, well-thought-out posts.

**Scope:** Server-side storage + automation + API + worker + browser package.

---

## State at handoff

- CDP/Chrome connectivity: WSL→Windows 127.0.0.1:9222 still broken. **Working path** is the existing `127.0.0.1:9222` URL through the zyquor script — DO NOT change this. Don't touch `scripts/open-x-profile-cdp.mjs`.
- OpenRouter: `ZYQUOR_OPENROUTER_API_KEY=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` and `ZYQUOR_OPENROUTER_MODEL=nex-agi/nex-n2-pro:free` are in `.env` and exported into the shell. API confirmed working.
- `nex-agi/nex-n2-pro:free` already added to `OPENROUTER_MODELS` allowlist in `packages/generation/src/index.ts`.

---

## Implementation

### Spacing (30–90 min, anti-cluster)

- `packages/core/src/spacing.ts` — `nextAutopostScheduledFor({ lastScheduledFor, timestamp, gapMinMinutes, gapMaxMinutes, recentGapMs })`.
  - Uniform random in [min, max] with ±15% jitter (`maxMs * 1.2` ceiling).
  - Anti-cluster: when the last 3 gaps have relative spread < 40%, force the picker to choose from `[45, 90]` min.
  - "Diverse from last": up to 8 retries to avoid candidates within 0.7–1.4× of the previous gap.
- `packages/storage/src/sqlite.ts:715-754` — `approveDraft` autopost branch uses the helper, reading last 5 autopost jobs for the account and computing recent gaps.
- `packages/storage/src/memory.ts:435-470` — same change for in-memory backend.
- Env: `ZYQUOR_POST_GAP_MIN_MINUTES=30`, `ZYQUOR_POST_GAP_MAX_MINUTES=90`.

### Quality floor + AI slop rejection

- `packages/automation/src/quality.ts:96-104` — `validateSourcePostQuality` rejects candidates that contain any `AI_SLOP_PHRASES` (75+ phrase list exported from `@zyquor/core`).
- `apps/api/src/app.ts:1132-1170` — yolo autopost path in `POST /drafts/:id/generate`:
  - Sorts candidates by `score.quality` DESC.
  - Reads `ZYQUOR_QUALITY_MIN` (default 3, matches `scoreTweetQuality` natural range — the additive score rarely exceeds 5 even for clean specific tweets).
  - Detects `AI_SLOP_PHRASES` substring on the best candidate.
  - On reject: writes `metadata.qualityGate = { bestQuality, bestCandidateId, threshold, slopPhrase, rejectedAt, reason }` and returns `{ draft, candidates, reason, bestQuality, threshold, slopPhrase }` with no `job` field.
  - On accept: proceeds with `approveDraft` (highest-scoring candidate).
- Added `updateDraftMetadata(draftId, metadata)` method to the repository (`packages/storage/src/types.ts`, `sqlite.ts`, `memory.ts`).
- `AI_SLOP_PHRASES` is now exported from `packages/core/src/index.ts`.

### Verification scripts

- `scripts/verify-spacing.mjs` — calls `nextAutopostScheduledFor` 20 times, asserts gaps are within `[min, max*1.2]`, stddev ≥ 10, ≤2 consecutive within 40% of each other. `pnpm spacing:check`.
- `scripts/verify-quality-gate.mjs` — boots the API with a stub generation provider, exercises three cases: high-quality (auto-approves with a 30–90 min scheduledFor), vague (rejected `all_below_quality_floor`), slop-text (rejected `ai_slop_phrase_detected`).

---

## Verified

```
pnpm -r build              # all 10 packages build clean
pnpm --filter @zyquor/core test         # 8/8
pnpm --filter @zyquor/storage test      # 10/10
pnpm --filter @zyquor/generation test   # 15/15
pnpm --filter @zyquor/worker test       # 13/13
pnpm spacing:check                       # OK: 20 gaps 32.1-89.5 min, stddev 16.2, 0 close
node scripts/verify-quality-gate.mjs    # all 3 paths produce expected responses
```

Live API: created draft → approved with `mode=autopost` → job's `scheduledFor` is 87.97 min from now.

---

## Worker is running

API, worker, and web are all running locally. The worker is actively polling, correctly skipping autopost jobs (X not logged in — Chrome CDP not up) and not claiming the future-scheduled job until its `scheduledFor` arrives.

---

## File-level checklist

```
packages/core/src/spacing.ts                [DONE]
packages/core/src/index.ts                  [DONE — exports + AI_SLOP_PHRASES]
packages/storage/src/sqlite.ts              [DONE — wire nextAutopostScheduledFor]
packages/storage/src/memory.ts              [DONE — wire nextAutopostScheduledFor]
packages/storage/src/types.ts               [DONE — add updateDraftMetadata]
packages/automation/src/quality.ts          [DONE — AI_SLOP_PHRASES check]
apps/api/src/app.ts                         [DONE — yolo path: sort by quality, drop <min, AI_SLOP_PHRASES, metadata.rejection]
.env / .env.example                         [DONE — POST_GAP_MIN/MAX, QUALITY_MIN]
package.json                                [DONE — spacing:check script]
scripts/verify-spacing.mjs                  [DONE]
scripts/verify-quality-gate.mjs             [DONE]
```

---

## Open questions

- **Yolo auto-click** — per taste the existing `ZYQUOR_ENABLE_BROWSER_POST` flag controls browser auto-clicks. The current default in `.env` is `1` but `.env.example` is `0`. The user said "the puppeteer post is shit" — but the worker setup is the main use case. Recommend keeping `ZYQUOR_ENABLE_BROWSER_POST=0` until the user explicitly opts in.
- **Quality floor of 3** — matches the natural `scoreTweetQuality` range. May want to make it configurable per-account via a `styleProfile.minQualityForAutopost` field. Out of scope for this pass — env-level for now.
- **Anti-cluster window** — currently triggers if last 3 gaps have variance < 40%. May want a wider window (last 5) or a tighter threshold (30%). Leaving 3/40% for the first iteration.
