# CLAUDE.md

Guidance for agents working in this repository. Favor caution, small changes, and verifiable progress.

## Project Context

Zyquor is a local-first X posting assistant. Current flow:

```
idea/source -> generated draft -> review/edit or autopost approval -> prepare/post -> history
```

Three creation lanes: `single` (one idea → candidates → approve), `batch` (multiple ideas → multiple jobs, optional schedule spacing), `yolo` (one idea → one candidate → `autopost` immediately).

Automated lane: deterministic source ingestion → compact source packet → one generated draft → approved autopost job. LLM never browses, scrapes, schedules, ranks, or decides whether to post.

X free-tier character limit enforced at 280. Tweet types: `feed_observation`, `news_context`, `useful_info`, `guide`, `lesson`, `tool`, `opinion`, `reply`, `hiring`, `article_summary`, `narrative_history`.

Controlled posting only behind env flags. Multi-account UI, reply drafting, Tauri, and E2E tests are future work.

## Architecture

- `apps/web`: Vite React UI.
- `apps/api`: Fastify API.
- `apps/worker`: background worker for due jobs.
- `packages/core`: domain types, Zod schemas.
- `packages/adapters`: source adapters, aggregation, source health.
- `packages/automation`: ingest and source-packet drafting.
- `packages/generation`: OpenRouter/Ollama/Gemini/mock providers.
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
- Failed external post jobs are not auto-retried because a failed browser action may still have reached X.

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
- `DELETE /source-packets/:id` — delete packet and safe non-posted draft

### Ingest Configs (CRUD for automated source ingestion)
- `GET /ingest-configs?accountId=`
- `POST /ingest-configs`
- `POST /ingest-configs/default-news`
- `PATCH /ingest-configs/:id`
- `DELETE /ingest-configs/:id`
- `GET /ingest-sources`
- `POST /ingest-run`
- `POST /ingest-run/async`

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
- `GET /history/analysis?accountId=&sinceHours=`

### Worker
- `GET /worker/status`
- `POST /worker/heartbeat`

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
- API: `http://127.0.0.1:3000` (falls back to 3001 if 3000 is busy)
- Web: `http://127.0.0.1:5173/`
- Worker polls due jobs every 5s

Env flags: `ZYQUOR_ENABLE_BROWSER_PREPARE=0`, `ZYQUOR_ENABLE_BROWSER_POST=0` (disabled by default for safety), `ZYQUOR_LLM_PROVIDER=openrouter|gemini|ollama|auto|mock`.
Source smoke: `pnpm smoke:adapters`. Product Hunt is optional without `ZYQUOR_PRODUCTHUNT_API_TOKEN`.

### pnpm Setup
Do not use the Hermes-installed pnpm. Install globally via npm:
```bash
npm install -g pnpm
ln -sf $(npm root -g)/pnpm/bin/pnpm.cjs ~/.local/bin/pnpm
```

### Generation Provider Resolution
- Provider is resolved in order: saved `data/generation.json` > `.env` > `process.env`.
- Setting `ZYQUOR_LLM_PROVIDER=openrouter` without `ZYQUOR_OPENROUTER_API_KEY` crashes the API. Use `auto` if the key is not yet available — it falls back through available providers.
- Shell env vars take precedence over `.env`; the dotenv loader skips already-set vars.
- Preferred provider is OpenRouter. Default model is `openrouter/owl-alpha`. The full free-model allowlist lives in `OPENROUTER_MODELS` in `packages/generation/src/index.ts`. Setting a model not in the list silently coerces to the default.

### Browser Automation Caveats
- Playwright bundled Chromium (`playwright install chromium`) fails on Ubuntu 26.04+ — it's unsupported on newer distros.
- On such systems, install system Chrome and set `ZYQUOR_BROWSER_CHANNEL=chrome`:
  ```bash
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
  sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list'
  sudo apt update && sudo apt install google-chrome-stable
  ```

## Latest Work (2026-05-08)

- Live adapter smoke added and arXiv RSS fallback fixed.
- Source health now cools down failing/empty aggregated upstreams.
- Post-history analysis and source metadata tracing exist.
- Source packet repost cap is 3 per account.
- TODO pruned so Next tracks remaining work only.

## Next Steps

**Maintainability** — split large API/web/generation/adapters files into route modules, services, components, and focused helpers.

**Worker reliability** — durable async ingest/generation/posting stages, worker UI panel, startup checks for posting readiness.

**Source routing/quality** — route job posts to hiring, blog/feed posts to article summary, preserve links/attribution, reduce generic framing.

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
