# CLAUDE.md

Guidance for agents working in this repository. Favor caution, small changes, and verifiable progress.

## Project Context

Zyquor is a local-first X posting assistant. V1 proves one account and one review-first workflow:

```
idea -> draft candidates -> review/edit -> approve -> prepare/post
```

Three creation lanes: `single` (one idea → candidates → approve), `batch` (multiple ideas → multiple jobs, optional schedule spacing), `yolo` (one idea → one candidate → `autopost` immediately).

Future automated lane: deterministic source ingestion (feeds, news, bookmarks, notes) → compact source packet → LLM writes candidate tweet → review/approve → post. LLM never browses, scrapes, schedules, ranks, or decides whether to post.

X free-tier character limit enforced at 280. Tweet types: `feed_observation`, `news_context`, `useful_info`, `guide`, `lesson`, `tool`, `opinion`, `reply`.

Controlled posting only behind env flags. Multi-account, scheduling, voice, Tauri are future work.

## Architecture

- `apps/web`: Vite React UI.
- `apps/api`: Fastify API.
- `apps/worker`: background worker for due jobs.
- `packages/core`: domain types, Zod schemas.
- `packages/generation`: mock/Ollama/Gemini providers.
- `packages/storage`: SQLite + JSON fallback repositories.
- `packages/browser`: Playwright prepare/post flow.
- `packages/accounts`: account config helpers.

Persistence: SQLite via `node:sqlite`, fallback JSON at `data/app.json`.

## Hard Constraints

- Use TypeScript.
- Use Playwright for browser automation.
- Dedicated persistent Chrome profiles per X account under `profiles/`.
- Never automate user's everyday Chrome profile.
- Do not use browser-use as production engine.
- Do not automate follows, likes, reposts, DMs, or engagement loops.
- No stealth, anti-detection, proxy rotation, CAPTCHA bypass.
- Keep Rust out of browser automation core.
- Final post action explicit and logged.
- LLM only writes candidate text; never browses, schedules, ranks, or decides to post.

## Working Rules

1. State assumptions before coding if request is ambiguous.
2. Keep changes small and tied to the requested goal.
3. Prefer explicit state machines and typed schemas over loose statuses.
4. Keep browser automation isolated in `packages/browser`.
5. Keep generation outside UI and browser packages.
6. Keep account profile mapping explicit and inspectable.
7. Store failure artifacts and attempt state; do not hide browser failures in console logs only.
8. Do not refactor unrelated code while implementing a feature.
9. Add or update focused tests for validation, state transitions, repositories, and API workflows.
10. Run verification when dependencies/tooling are available; report exact blockers when they are not.

## API Routes

### Drafts
- `POST /drafts` — generate candidates from idea
- `GET /drafts/:id` — get draft with candidates
- `POST /drafts/:id/select` — select candidate, optionally edit text
- `POST /drafts/:id/approve` — approve with optional mode/scheduledFor → creates job

### Batch
- `POST /draft-batches` — multiple jobs from ideas, optional schedule spacing

### Jobs
- `GET /jobs?accountId=` — list jobs filtered by account
- `POST /jobs/:id/prepare` — dry-run or real browser prepare
- `POST /jobs/:id/post` — explicit post click (requires `ZYQUOR_ENABLE_BROWSER_POST=1`)
- `POST /jobs/post-ready` — queue all ready jobs (shuffled, sequential)
- `DELETE /jobs/:id` — delete non-running job
- `GET /jobs/:id/attempts` — attempt logs

### Source Packets
- `GET /source-packets?accountId=` — list packets
- `POST /source-packets` — create packet
- `POST /source-packets/:id/draft` — generate draft from packet → marks drafted

### Ingest Configs (CRUD for automated source ingestion)
- `GET /ingest-configs?accountId=`
- `POST /ingest-configs`
- `PATCH /ingest-configs/:id`
- `DELETE /ingest-configs/:id`

IngestConfig fields: `accountId`, `sourceType`, `maxPacketsPerDay`, `tweetTypeMix` (Record<TweetType, number>), `scheduleWindowStart` (HH:MM), `scheduleWindowEnd` (HH:MM), `enabled`.

### Style Profiles
- `GET /style-profiles/:id`
- `PATCH /style-profiles/:id` — update tone/rules/bannedPhrases/systemPromptExtra

### Generation Config
- `GET /generation` — current provider/model
- `PATCH /generation` — change provider/model at runtime

### Browser
- `GET /browser/x-session?accountId=` — check X login state

### Accounts
- `GET /accounts`
- `PATCH /accounts/:id`

### History
- `GET /history`
- `GET /jobs/:id/attempts`

## Web UI State

Mode derived from UI inputs:
- Schedule set → `scheduled`
- No schedule + Yolo → `autopost`
- No schedule + no Yolo → `prepare_only`

Controls: idea composer (single/batch), tweet type, Yolo autopost toggle, schedule datetime, batch spacing, candidates/editor, prompt/style panel (tone/objective/banned/system), source packets panel, jobs panel.

Removed from UI: noisy account/profile/daily-limit editing. Account config remains in storage/API.

## Current Runtime

```
./zyquor
./zyquor check
./zyquor post <jobId>
```

- Chrome CDP: `http://127.0.0.1:9222`, profile `profiles/personal-main`
- API: `http://127.0.0.1:3001`
- Web: `http://127.0.0.1:5173/`
- Worker polls due jobs every 5s

Env flags: `ZYQUOR_ENABLE_BROWSER_PREPARE=1`, `ZYQUOR_ENABLE_BROWSER_POST=1`, `ZYQUOR_LLM_PROVIDER=gemini|ollama|mock`.

## Latest Work (2026-04-26)

- Ingest config system: schema + storage + API CRUD (`GET/POST/PATCH/DELETE /ingest-configs`)
- Post-click verification: `resolvePostedPermalink` polls up to 5s after click
- All tests passing: 14 API, 7 core, 5 generation, 4 storage, 3 browser, 3 worker, 2 accounts

## Next Steps

**Ingest runner** — next major feature. Needs:
1. `POST /ingest-run` endpoint (reads enabled configs, creates packets/drafts/jobs)
2. Source adapter interface (feed/news URL → source packet)
3. Daily packet count enforcement per config
4. Schedule window time-of-day guard
5. Tweet type selection from `tweetTypeMix` weights (not random)

**Reply drafting** — explicit reviewable jobs for reply tweets. Needs:
- Reply target tracking (tweet ID, author handle)
- Reply draft generation
- Reusable in normal single/batch/yolo flows

**Deferred**: multi-account UI, voice input, Tauri desktop, E2E test suite.

## Common Commands

```bash
pnpm bootstrap
pnpm smoke
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm check
pnpm test
pnpm build
```