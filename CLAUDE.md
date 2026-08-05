# CLAUDE.md

Guidance for agents working in this repository. Favor caution, small changes, and verifiable progress.

## Project Context

Zyquor is a local-first X posting assistant. Current flow:

```
idea/source -> generated draft -> review/edit or autopost approval -> prepare/post -> history
```

Three creation lanes: `single` (one idea → candidates → approve), `batch` (multiple ideas → multiple jobs, optional schedule spacing), `yolo` (one idea → one candidate → `autopost` immediately).

Automated lane: deterministic source ingestion → compact source packet → one generated draft → approved autopost job. LLM never browses, scrapes, schedules, ranks, or decides whether to post.

Draft quality has two layers (2026-07-21): a Luna insight and reader-critic LLM pass inside the providers (insight → generate → fact/editorial audit → reader critique → revise → final audit → drop rejected; all-dropped means no draft), and `scoreTweetQuality` in `packages/generation/src/quality.ts`, a floor (`ZYQUOR_QUALITY_MIN`, default 7) against recaps and slop, not a ranker. Measure prompt/pipeline changes with `node scripts/tweet-eval.mjs` (real provider calls plus an independent Command Code judge; reports floor rate, judge coverage, and mean scores).

X free-tier character limit enforced at 280. Tweet types: `feed_observation`, `news_context`, `useful_info`, `guide`, `lesson`, `tool`, `opinion`, `reply`, `hiring`, `article_summary`, `narrative_history`.

Controlled posting only behind env flags. Multi-account UI, Tauri, and E2E tests are future work. Reply drafting shipped (plan 007-C).

## Architecture

- `apps/web`: Vite React UI.
- `apps/api`: Fastify API.
- `apps/worker`: background worker for due jobs.
- `packages/core`: domain types, Zod schemas.
- `packages/adapters`: source adapters, aggregation, source health.
- `packages/automation`: ingest and source-packet drafting.
- `packages/generation`: command-code/OpenRouter/Ollama/Gemini providers (no mock provider; tests inject providers via buildApp options).
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
- `GET /source-packets/:id/draft` — existing draft for a packet (review)
- `POST /source-packets/:id/regenerate` — save feedback, replace draft, redraft with feedback in prompt
- `POST /source-packets/:id/feedback` — save/clear packet feedback without redrafting
- `DELETE /source-packets/:id` — delete packet and safe non-posted draft

### System Feedback (standing corrections injected into every generation)
- `GET /system-feedback?accountId=` — list
- `POST /system-feedback` — add `{accountId, text}`
- `DELETE /system-feedback/:id`

Feedback (post-level and standing) is appended to `feedback/notebook.md` in the project root (path from `feedbackDir` desktop setting; default `process.cwd()/feedback`). Coding agents should read that notebook before changing generation code or prompts.

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

### System (desktop control plane)
- `GET /system/status`
- `POST /system/posting` — toggle prepare/post flags live
- `POST /system/ingest/cancel`
- `GET /system/logs`
- `POST /system/worker/pause`
- `POST /system/chrome/close`
- `POST /system/stop-all`
- `POST /system/quit`, `POST /system/restart` (desktop only)

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

# Electron desktop app (Windows)
pnpm dev:desktop
pnpm smoke:desktop
pnpm dist:desktop
```

- Chrome CDP: `http://127.0.0.1:9222`, profile `profiles/personal-main`
- API: `http://127.0.0.1:3000` (falls back to 3001 if 3000 is busy)
- Web: `http://127.0.0.1:5173/`
- Worker polls due jobs every 5s
- Electron desktop app: `apps/desktop/` — Electron 37, tray-resident, runs API/worker in-process. Data root via `ZYQUOR_DATA_ROOT` (defaults to Electron `userData`). Settings kept as `settings.json` in data root instead of `.env`. Logs to `<dataRoot>/logs/main.log` (rotates at 5 MB). Entry points: `src/main.ts` (main process), `src/preload.ts` (context bridge), `src/chrome.ts` (CDP launch), `src/settings.ts` (JSON config), `src/log.ts` (file logging).

Env flags: `ZYQUOR_ENABLE_BROWSER_PREPARE=0`, `ZYQUOR_ENABLE_BROWSER_POST=0` (disabled by default for safety), `ZYQUOR_LLM_PROVIDER=command-code|codex|openrouter|gemini|ollama|auto`.
Source smoke: `pnpm smoke:adapters`. Product Hunt is optional without `ZYQUOR_PRODUCTHUNT_API_TOKEN`.

### pnpm Setup
Do not use the Hermes-installed pnpm. Install globally via npm:
```bash
npm install -g pnpm
ln -sf $(npm root -g)/pnpm/bin/pnpm.cjs ~/.local/bin/pnpm
```

### Generation Provider Resolution
- Provider is resolved in order: saved `data/generation.json` > `.env` > `process.env`.
- Set `ZYQUOR_LLM_PROVIDER` explicitly to `command-code` or `codex`; the desktop setup does not use `auto` or OpenRouter.
- Shell env vars take precedence over `.env`; the dotenv loader skips already-set vars.
- Preferred provider is `command-code` with model `gpt-5.6-luna`. Codex remains available with model `luna`; CLI paths use `ZYQUOR_CODEX_PATH` and `ZYQUOR_COMMAND_CODE_PATH`. Both CLI providers run the audit and reader-critic pipeline. OpenRouter is not used by the desktop setup.

### Browser Automation Caveats
- Playwright bundled Chromium (`playwright install chromium`) fails on Ubuntu 26.04+ — it's unsupported on newer distros.
- On such systems, install system Chrome and set `ZYQUOR_BROWSER_CHANNEL=chrome`:
  ```bash
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
  sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list'
  sudo apt update && sudo apt install google-chrome-stable
  ```

## Latest Work (2026-08-03)

- Two-level feedback: per-post feedback stored on the source packet, injected into that packet's redraft, regenerates the post for review (`/source-packets/:id/regenerate`); per-account standing feedback injected into every generation's system prompt (`/system-feedback`). Both append entries to `feedback/notebook.md` (repo root) for coding agents to act on.
- Source packets panel gained Review (open existing draft) and Regenerate (feedback + redraft) actions; Style panel gained a system feedback list.

## Latest Work (2026-07-21)

- Reader-critic quality pipeline in the command-code provider plus `scripts/tweet-eval.mjs` for measuring it.
- Ingest grounding: fresh-source filter (48h), host caps, topic-overlap and thin-context skips.
- Desktop control plane: `/system/*` routes (status, posting toggle, logs, worker pause, chrome close, stop-all, quit, restart) and a System view in the web UI.
- Source health cools down failing/empty aggregated upstreams; post-history analysis and source metadata tracing exist.

## Next Steps

Shipped since the last update (plans/006, plans/007): Electron desktop app,
api/web file splits, worker durability + status panel, source routing/quality,
reply drafting end-to-end, web design pass, safety fixes (manual review never
autoposts by default, masked keys can't clobber real ones, stealth flag
removed, posting disabled by default everywhere).

**Remaining**: split large generation/adapters files; account creation flow
(only GET/PATCH exist); schedule-clearing via PATCH /jobs/:id; shuffled
post-all (docs promised, code is chronological); surface quality-gate-failed
drafts in UI; app icon + Windows code signing; OS keychain for API keys;
auto-update.

**Deferred**: multi-account UI, voice input, E2E test suite.

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
----
# Delegation Rules

You are the **coordinator**: design, decide, review, land. Delegate hands-on execution and well-scoped research to **executor subagents** (Agent tool, `model: sonnet') or to the command-code CLI running DeepSeek V4 Pro.

## Role check first

- If your prompt starts with `ROLE: EXECUTOR` — or you were spawned by another agent at all — you are an **executor**: ignore the rest of this file, do the work order yourself, **never spawn subagents**. If blocked or the order is ambiguous, report back instead of delegating.
- Coordinator: start every executor prompt with `ROLE: EXECUTOR — do the work yourself; do not spawn subagents.`

## Delegate (default for hands-on work)

- Implementation from a frozen spec; refactors; migrations
- Bug fixes, CI/lint/type failures, tests, dependency bumps, tooling
- Read-heavy exploration — fan out parallel executors, each returns a distilled summary
- Git mechanics (rebase, conflicts, merge workflow) — mechanics only, after the coordinator decides to land

## Keep in the coordinator

- Design, architecture, naming, UX judgment; tasks where writing the spec IS the work
- Tiny edits (~<20 lines) — delegation overhead loses
- Session tools (MCP, secrets), releases/publishes/version bumps
- The land decision, pre-land gates (review clean, CI green, proof), and review of all executor output — never delegated, never skipped

## How

- Complex work: freeze the spec as a md file in `/tasks` first; executor prompts reference it. Small work: full work order inline in the prompt, no spec file.
- Executor prompts are self-contained (context, constraints, expected output) — subagents don't see your conversation.
- Review output before accepting; re-delegate failures with the error context included.
- Heuristic: prompt reads as a work order → delegate; writing it forces decisions → coordinator.
