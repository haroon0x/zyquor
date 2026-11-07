# CLAUDE.md

Guidance for agents working in this repository. Favor caution, small changes, and verifiable progress.

License: AGPL-3.0-only (see `LICENSE`).

## Rust Migration (in progress)

Zyquor is being fully migrated from TypeScript to Rust. `docs/rust-migration.md` is the plan of record: target Cargo workspace layout, crate-by-crate mapping, milestones M0–M8, parity strategy, and risks.

- Target layout: `crates/zyquor-{core,accounts,storage,adapters,generation,automation,browser}` plus `apps/{api,worker,desktop,web}` in one Cargo workspace.
- The TypeScript tree remains the running system until each Rust crate passes its parity harness. Nothing is deleted early. Within a crate that has been ported, new work goes into the Rust version, not the TypeScript one.
- Build and verify with `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- The migration must not change behaviour: same HTTP routes and response shapes, same SQLite data, same generation output for the same input, same posting safety rails.

## Project Context

Zyquor is a local-first X posting assistant. Current flow:

```
idea/source -> generated draft -> review/edit or autopost approval -> prepare/post -> history
```

Three creation lanes: `single` (one idea → candidates → approve), `batch` (multiple ideas → multiple jobs, optional schedule spacing), `yolo` (one idea → one candidate → `autopost` immediately).

Automated lane: deterministic source ingestion → compact source packet → one generated draft → approved autopost job. The LLM never browses, scrapes, schedules, ranks, or decides whether to post.

Draft generation is a single LLM call that writes candidates with all anti-slop guidance (voice, punctuation, style contract, banned phrases, source boundary) carried in the system + user prompt, retried once with a simpler line prompt only when the output cannot be parsed. `score_tweet_quality` in `crates/zyquor-generation/src/quality.rs` is a deterministic floor (`ZYQUOR_QUALITY_MIN`, default 7) against recaps and slop, not a ranker. There is no separate LLM judge in the pipeline. Measure prompt/pipeline changes with `cargo run -p zyquor-cli -- tweet-eval`.

Tweet types (`TWEET_TYPES` in `packages/core/src/index.ts`): `feed_observation`, `useful_info`, `guide`, `opinion`, `reply`, `narrative_history`. The retired types (`news_context`, `lesson`, `tool`, `hiring`, `article_summary`) are folded into these on database open.

Controlled posting only behind env flags (`ZYQUOR_ENABLE_BROWSER_PREPARE` / `ZYQUOR_ENABLE_BROWSER_POST`; both disabled by default). Multi-account works end to end: accounts can be created, switched, enabled, and deleted in the web UI or via `POST /accounts` / `DELETE /accounts/:id`, each with its own profile and CDP port. Per-account limits and quiet hours are not editable in the web UI yet. Desktop shell decision is locked: **Tauri v2** (M6). E2E tests are future work (see Next Steps).

## Architecture

> Migration target: `crates/zyquor-*` + `apps/api` (axum) + `apps/worker` + `apps/desktop` (Tauri) in a Cargo workspace. The list below describes the TypeScript tree that is still running.

- `apps/web`: Vite React UI. `apps/api`: Fastify API. `apps/worker`: background worker for due jobs. `packages/core`: domain types, Zod schemas. `packages/adapters`: source adapters, aggregation, source health.
- `packages/automation`: ingest and source-packet drafting. `packages/generation`: command-code/opencode/Ollama/Gemini providers (no mock provider; tests inject providers via buildApp options). `packages/storage`: SQLite repositories. `packages/browser`: Playwright prepare/post flow. `packages/accounts`: account config helpers.

Persistence: SQLite via `node:sqlite`. There is no JSON fallback; SQLite is the only repository implementation.

## Hard Constraints

- Language: Rust is the migration target (see "Rust Migration" above and `docs/rust-migration.md`). TypeScript is legacy and stays only until the corresponding Rust crate reaches parity.
- Browser automation: Playwright (`playwright-core` over CDP) is the current engine; the Rust target is direct CDP via `chromiumoxide` in `crates/zyquor-browser`.
- Dedicated persistent Chrome profiles per X account under `profiles/`. Never automate the user's everyday Chrome profile.
- Do not use browser-use as the production engine. Do not automate follows, likes, reposts, DMs, or engagement loops.
- No stealth, anti-detection, proxy rotation, or CAPTCHA bypass.
- Browser automation stays isolated in the browser crate (was `packages/browser`, becomes `crates/zyquor-browser`); isolation and the anti-detection bans still apply.
- Final post action is explicit and logged. The LLM only writes candidate text; never browses, schedules, ranks, or decides to post.
- Failed external post jobs are not auto-retried because a failed browser action may still have reached X.
- Playwright's bundled Chromium (`playwright install chromium`) can fail on very new distros; if yours is affected, install system Chrome and set `ZYQUOR_BROWSER_CHANNEL=chrome`.

## Working Rules

1. State assumptions before coding if the request is ambiguous.
2. Keep changes small and tied to the requested goal.
3. Prefer explicit state machines and typed schemas over loose statuses.
4. Keep browser automation isolated in `packages/browser` (TypeScript) / `crates/zyquor-browser` (Rust).
5. Keep generation outside UI and browser packages.
6. Keep account profile mapping explicit and inspectable.
7. Store failure artifacts and attempt state; do not hide browser failures in console logs only.
8. Do not refactor unrelated code while implementing a feature.
9. Add or update focused tests for validation, state transitions, repositories, and API workflows.
10. Run verification when dependencies/tooling are available; report exact blockers when they are not.

## API Routes

### Drafts
- `POST /drafts` — generate candidates from idea. `GET /drafts/:id` — get draft with candidates. `POST /drafts/:id/select` — select candidate, optionally edit text.
- `POST /drafts/:id/approve` — approve with optional mode/scheduledFor → creates job. Optional `screened:true` turns on the server-side agent screen: rejects 409 when text fails `isCleanTweetText`, `passesTweetQualityFloor`, or the length/cleanliness checks. Agents must always send it; humans omit it to override by judgment.
- `GET /drafts/quality-gate-failures` — drafts rejected by the quality gate (surfaced in the Compose "Quality gate rejections" panel).

### Replies (reply lane, drafts only: nothing here posts)
- `GET /replies/feed?accountId=` — scan the X home feed for reply targets
- `POST /replies/from-url` — fetch one post URL and create a reply draft (optional `useMemory` override; optional `count` 1..50 best-of-N; captures up to 6 existing replies under the target into `metadata.sourceReplies` with a do-not-repeat instruction; large pools get bounded top-up passes)
- `GET /replies/mentions?accountId=` — fresh (48h) mentions with drafted/posted flags
- `POST /replies/mentions/draft` — draft replies for chosen mention URLs (body `{mentions:[{url}]}`)
- `POST /replies/mentions/scan-and-draft` — scan and draft all fresh undrafted mentions (cap 10 per call)
- `POST /replies/mentions/scan-and-auto-approve` — capped auto-approve lane (off unless `ZYQUOR_MENTIONS_AUTO_APPROVE=1`). Approves only when the top candidate clears `passesTweetQualityFloor`, within `ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP` (default 3, 0 disables, clamped 0..50). Creates a normal queued post job; posting stays gated by worker/browser flags, limits, and quiet hours. Held drafts stay in the review queue.
- `GET /replies/drafts?accountId=` — reply drafts awaiting review. Drafts carry `metadata.memory` (Goldfish terms/wiki/activity titles); memory is capped at 1600 chars inside the `<personal-memory>` prompt block.

### Batch
- `POST /draft-batches` — multiple jobs from ideas, optional schedule spacing

### Jobs
- `GET /jobs?accountId=` — list jobs filtered by account
- `PATCH /jobs/:id` — set or clear a job's schedule (`scheduledFor` ISO datetime, or `null` to clear); jobs panel has a clear-schedule action
- `POST /jobs/:id/prepare` — dry-run or real browser prepare. `POST /jobs/:id/post` — explicit post click (requires `ZYQUOR_ENABLE_BROWSER_POST=1`)
- `POST /jobs/:id/retry` — verify-then-retry. Scans the target thread for the account's own reply (falls back to the account's `/with_replies` timeline) and marks the job posted when found; otherwise re-arms `failed -> approved` and reposts through the fully gated path. Returns 409 only when both scans fail. Use only on an explicit human ask.
- `POST /jobs/post-ready` — queue all ready jobs (shuffled, sequential). `DELETE /jobs/:id` — delete non-running job. `GET /jobs/:id/attempts` — attempt logs

### Source Packets
- `GET /source-packets?accountId=` — list packets. `POST /source-packets` — create packet
- `POST /source-packets/:id/draft` — generate draft from packet → marks drafted. `GET /source-packets/:id/draft` — existing draft for a packet (review)
- `POST /source-packets/:id/regenerate` — save feedback, replace draft, redraft with feedback in prompt. `POST /source-packets/:id/feedback` — save/clear packet feedback without redrafting
- `DELETE /source-packets/:id` — delete packet and safe non-posted draft

### System Feedback (standing corrections injected into every generation)
- `GET /system-feedback?accountId=` — list. `POST /system-feedback` — add `{accountId, text}`. `DELETE /system-feedback/:id`
- Feedback (post-level and standing) is appended to `feedback/notebook.md` in the project root (path from the `feedbackDir` desktop setting; default `process.cwd()/feedback`; directory is gitignored). Read it before changing generation code or prompts.

### Ingest Configs (CRUD for automated source ingestion)
- `GET/POST /ingest-configs`, `POST /ingest-configs/default-news`, `PATCH/DELETE /ingest-configs/:id`, `GET /ingest-sources`, `POST /ingest-run`, `POST /ingest-run/async`
- IngestConfig fields: `accountId`, `sourceType`, `maxPacketsPerDay`, `tweetTypeMix` (Record<TweetType, number>), `scheduleWindowStart`/`scheduleWindowEnd` (HH:MM), `enabled`.

### Style Profiles
- `GET /style-profiles/:id`. `PATCH /style-profiles/:id` — update tone/rules/bannedPhrases/systemPromptExtra; `rules.replyMemory` (default on) grounds replies in Goldfish memory

### Generation Config
- `GET /generation` — current provider/model. `PATCH /generation` — change provider/model at runtime

### Browser
- `GET /browser/x-session?accountId=` — check X login state

### Accounts
- `GET /accounts`. `POST /accounts` — create (`handle`, optional `displayName`; profile dir is `profiles/<handle>`). `PATCH /accounts/:id`. `DELETE /accounts/:id`

### History and Worker
- `GET /history` · `GET /history/analysis?accountId=&sinceHours=` · `GET /worker/status` · `POST /worker/heartbeat`

### System (desktop control plane)
- `GET /system/status`. `POST /system/posting` — toggle prepare/post flags live. `POST /system/ingest/cancel`. `GET /system/logs`. `POST /system/worker/pause`. `POST /system/chrome/close`. `POST /system/stop-all`. `POST /system/quit`, `POST /system/restart` (desktop only)

## Web UI State

Mode from UI inputs: schedule set → `scheduled`; no schedule + Yolo → `autopost`; otherwise `prepare_only`. Controls: idea composer (single/batch), tweet type, Yolo autopost toggle, schedule datetime, batch spacing, candidates/editor, prompt/style panel (tone/objective/banned/system), source packets panel, jobs panel, accounts (create/switch/enable/delete; the Accounts panel does not edit limits or quiet hours yet).

## Current Runtime

```bash
cargo run -p zyquor-cli -- start          # API + worker + web dev
cargo run -p zyquor-cli -- check-login    # verify the dedicated-profile X session
cargo run -p zyquor-cli -- post-loop --once  # one original post, if under cap
# Tauri desktop app (Windows)
cargo tauri dev                            # apps/desktop (same IPC surface as Electron)
cargo run -p zyquor-desktop -- --headless-smoke   # boot + /accounts + /worker/status, no window
cargo tauri build                          # tauri.conf.json bundle
```

- Chrome CDP: the posting Chrome binds its debugging port to loopback only. From another host/namespace, use a portproxy or a direct CDP URL that is actually reachable (e.g. a `netsh portproxy` rule forwarding host port → loopback port). Dedicated profile under `profiles/<handle>`; headless via `ZYQUOR_BROWSER_HEADLESS=1`.
- API: `http://127.0.0.1:3001` locally (port 3000 is usually taken; with `ZYQUOR_API_PORT` unset the server falls back to 3001 on conflict — set it explicitly). Web: `http://127.0.0.1:5173/`. Worker polls due jobs every 5s.
- Tauri desktop app: `apps/desktop/` — Tauri v2, tray-resident, runs API/worker in-process. Data root via `ZYQUOR_DATA_ROOT` (defaults to the Tauri app data dir). Settings kept as `settings.json` instead of `.env`; API keys are NOT encrypted at rest in the Rust port (the Electron `safeStorage` encryption has no Tauri equivalent yet — `settings.rs` warns once on save; legacy `enc:v1:` values are parsed transparently). Logs to `<dataRoot>/logs/main.log` (rotates to a single `main.log.1` at 5 MB). Entry points: `src/main.rs`, `src/controls.rs`, `src/chrome.rs` (CDP launch), `src/settings.rs`, `src/log.rs`.
- Desktop settings worth knowing: `headless` maps to `ZYQUOR_BROWSER_HEADLESS` (default off), `cdpPort` maps to `ZYQUOR_BROWSER_CDP_URL`. Per-account ports resolve through `per_profile_cdp_url` from `zyquor_core::paths` — the same helper the API uses. Do not reimplement that mapping anywhere else.
- Desktop window: the Tauri `on_navigation` guard mirrors the Electron `setWindowOpenHandler`/`will-navigate` pairing (external http(s) → system browser, everything else denied). Never remove those guards; without them a link in the UI opens a bare webview with no address bar.

Env flags: `ZYQUOR_ENABLE_BROWSER_PREPARE=0`, `ZYQUOR_ENABLE_BROWSER_POST=0` (disabled by default), `ZYQUOR_LLM_PROVIDER=command-code|opencode|gemini|ollama|auto`. `ZYQUOR_REVISION_PASS=1` adds a cut-only second-pass revision (opencode only): removes vagueness and unsupported claims from the first-pass drafts, never adds material, cannot lower a candidate; off by default. Source adapter tests: `cargo test -p zyquor-adapters`. Product Hunt is optional without `ZYQUOR_PRODUCTHUNT_API_TOKEN`.

### Generation Provider Resolution

- Provider resolution order: saved `data/generation.json` > shell env > `.env` (dotenv skips already-set vars; saved config wins over both).
- `opencode` is the configured provider and the desktop default (`apps/desktop/src/main.rs` merges the default settings); it drives the opencode CLI (`opencode run -m <model>#<variant>`).
- Default model: `opencode/glm-5.3-flash-free`, variant `high` (`DEFAULT_OPENCODE_MODEL` in `crates/zyquor-generation/src/config.rs`). The opencode ladder is exactly three models (`OPENCODE_MODELS`): `opencode/glm-5.3-flash-free`, `opencode-go/glm-5.3-flash`, `opencode/deepseek-v4.1-flash`. Other tags are rejected; rotation outside this ladder is banned and triggers only on rate-limit/unavailable/funds errors — transient network drops never rotate.
- The free tier cap is shared across all `opencode/*` free models; when exhausted, every lane fails with `Free usage limit reached` — an account quota, not a code fault. Paid models need funds on your account. `command-code` (model `gpt-5.6-luna`) also works but needs paid credits. `gemini` needs `ZYQUOR_GEMINI_API_KEY`; `ollama` is local (default `gemma4:e4b`); `auto` prefers Gemini, else Ollama. CLI paths: `ZYQUOR_COMMAND_CODE_PATH` / `ZYQUOR_OPENCODE_PATH`; model and variant: `ZYQUOR_OPENCODE_MODEL` / `ZYQUOR_OPENCODE_VARIANT`.
- A Codex provider was written and removed (Codex unavailable); Freebuff was evaluated and rejected (TUI, no non-interactive mode); do not re-add either. OpenRouter was removed as a generation provider; `packages/adapters/src/model-releases.ts` still calls OpenRouter's public models endpoint for source ingestion — that is not generation.
- The opencode CLI sometimes exits 1 with `ECONNRESET` after a long run while complete candidates JSON is already on stdout; the provider accepts stdout when it parses as candidates, otherwise fails normally. The rescue and truncated-JSON cases are covered in the opencode provider tests in `crates/zyquor-generation`.

### X Render Failures Are Not Logouts

- Symptom: X loads its shell but stays on the `Loading…` placeholder forever. `document.body.innerText` is empty and no console or page errors appear, while the credentials and timeline endpoints all return 200. The session is valid; the client just stopped painting.
- `assertNotLoginPage` treats "authenticated UI not visible" as "not logged in" only when the credentials check also fails. If the credentials endpoint returns a handle, it throws a distinct render error (`X did not render the authenticated shell ... do not clear cookies`).
- Never clear x.com site data or cookies on that error. Clearing site data deletes a valid session and turns a render bug into a forced login.
- Recovery order: relaunch the dedicated Chrome profile, then retry. If the same profile still will not render, move to a fresh profile and log in once — a corrupt profile can survive cookie, storage, IndexedDB, service-worker, cache, and extension clears.

### Posting Chrome CDP Ports

- `perProfileCdpUrl` (`packages/core/src/paths.ts`) derives each profile's CDP port from the base URL. Profiles in `ZYQUOR_BROWSER_CDP_BASE_PROFILES` (comma-separated, default `personal-main`) stay on the base port; anything else resolves to a stable hash offset.
- If only the base port is reachable (e.g. a single forwarded port), a profile that hashes to another offset resolves to a dead port and posting fails with `Chrome CDP is unavailable at <base+offset>`. Add the active profile to `ZYQUOR_BROWSER_CDP_BASE_PROFILES` instead of opening more forwarding rules.
- Settings `cdpPort` rewrites the base URL, not the offsets. The env list is the supported way to pin a profile to the base port.

### Headless Posting Chrome

- `ZYQUOR_BROWSER_HEADLESS=1` makes the posting Chrome run `--headless=new` on the same profile and CDP port, with no visible window. `ensureBrowserCdp` honours it, so auto-launch after a CDP loss does not reopen one.
- Keep a headed variant of your Chrome relaunch helper for debugging a page that will not render. Headless has been verified end to end (login, feed render, composer fill, feed scan); the UA contains `HeadlessChrome` and X still serves the full client. If X stops painting only in headless, relaunch headed and compare before changing code.
- Debugging headless means screenshots (`apps/api/data/artifacts`), not looking at a window.

### Browser Job Failure Modes

- Chrome raises a `beforeunload` dialog when a page navigates or closes with unsent composer text. Playwright's internal auto-dismiss races Chrome and throws `No dialog is showing` from an unhandled promise. The Rust `zyquor-browser` session dismisses dialogs synchronously on every page it touches, and the API logs unhandled panics instead of exiting.
- A failed post can leave the composer holding the text. Clear it before the next attempt (`Control+A`, `Backspace`) or the next navigation triggers that dialog.

### Posts-Only Reply Loop

`zyquor reply-loop` (`apps/cli/src/reply_loop.rs`) is the unattended posts-only lane. It does not touch mentions. It discovers targets from `GET /replies/feed` first (accounts you follow), then falls back to X search through the logged-in Chrome when the feed is thin, already seen, or rejected. It drafts best-of-N through `POST /replies/from-url`, applies a deterministic slop screen, then approves with `screened:true` and posts through the normal gated job path. Every rejection is appended to `apps/api/data/reply-loop.jsonl` with a reason, which is the input for tightening prompts or filters. Screen reasons, and why each exists:

- `invented_number`: a digit in the reply that does not appear in the target. `invented_experience`: claims of having used, run, shipped, or deployed the thing (first-person opinion like `my pick is` is allowed; fabricated usage is not).
- `lowercase_opener`: the account voice is sentence case, so an all-lowercase opener reads like a different person. `invented_point`: `Point 2` when the target is not a numbered list.
- Formula contrasts, advice openers, and the usual slop words. Quality floor, which must match `replyQualityMinimum` in `@zyquor/generation` (5); the post scorer was calibrated on 220–480 character posts and a one-line reply rarely reaches the post floor while still being clean.

```bash
cargo run -p zyquor-cli -- reply-loop --once --dry   # discover, draft, report; no approval
cargo run -p zyquor-cli -- reply-loop --once         # one cycle, may post
cargo run -p zyquor-cli -- reply-loop                # every 30 min, max 1 post per cycle
```

Env: `ZYQUOR_REPLY_LOOP_QUERIES`, `ZYQUOR_REPLY_LOOP_INTERVAL_MS` (default 30 min), `ZYQUOR_REPLY_LOOP_MAX_POSTS` (default 1), `ZYQUOR_REPLY_LOOP_MAX_PER_DAY` (default 20, rolling 24h from `/performance`), `ZYQUOR_REPLY_LOOP_MIN_QUALITY` (default 5), `ZYQUOR_REPLY_LOOP_CANDIDATES` (default 4), `ZYQUOR_REPLY_LOOP_RETRY_HOURS` (default 6). Starts a posting lane — run only on an explicit ask. Failed drafts are remembered for `ZYQUOR_REPLY_LOOP_RETRY_HOURS`, not forever; posted and screen-rejected targets stay permanent.

Demand-style openers ("explain X", "make me X", "can you X") are rejected for outgoing agent replies in all approval sites (`is_interrogation_dodge_reply` in `crates/zyquor-generation/src/quality.rs`): the `screened:true` approval screen, the mentions auto-approve gate, `zyquor overseer`, and the reply-loop screen.

### Original Post Loop

`zyquor post-loop` (`apps/cli/src/post_loop.rs`) is the standalone post lane, separate from replies. It walks a rotating topic bank in least-recently-used order (`TOPIC_BANK` near the top of the file, safe to edit), creates a draft through `POST /drafts`, generates candidates through `POST /drafts/:id/generate`, screens them, then selects, approves with `screened:true`, and posts through `POST /jobs/:id/post`. It posts about 5 originals a day inside a 09:00 to 22:00 account-local window, with a full interval between originals so a late start cannot burn the day's quota in one burst. The cap and spacing come from `GET /performance` history, not local counters, so a restart cannot exceed the limit. Only rows with `tweetType !== "reply"` count as originals. Decisions and rejections go to `apps/api/data/post-loop.jsonl`; rotation state and the recent-text de-dupe list live in `apps/api/data/post-loop-state.json`.

Screen reasons: `too_short` (under 180 chars), `too_long` (over 620), `lowercase_opener`, `question_bait`, `hashtag_or_mention`, `has_link`, `dash`, `slop_word`, `formula_contrast`, `invented_experience`, `invented_stat`, `repeat`.

```bash
cargo run -p zyquor-cli -- post-loop --once --dry    # draft and report; no approval
cargo run -p zyquor-cli -- post-loop --once          # post now if under the daily cap
cargo run -p zyquor-cli -- post-loop                 # run forever
cargo run -p zyquor-cli -- post-loop --once --force  # ignore the daily cap
```

Env: `ZYQUOR_POST_ACCOUNT_ID` (default `account_personal`), `ZYQUOR_POST_LOOP_PER_DAY` (default 5), `ZYQUOR_POST_LOOP_START_HOUR` (default 9), `ZYQUOR_POST_LOOP_END_HOUR` (default 22), `ZYQUOR_POST_LOOP_UTC_OFFSET_MIN` (default 330, i.e. UTC+5:30), `ZYQUOR_POST_LOOP_MIN_QUALITY` (default 7), `ZYQUOR_POST_LOOP_CANDIDATES` (default 4), `ZYQUOR_POST_LOOP_MIN_GAP_MIN` (default 20). Also starts a posting lane.

## Common Commands

`cargo run -p zyquor-cli -- start` · `cargo run -p zyquor-cli -- api` · `cargo run -p zyquor-cli -- worker` · `cargo run -p zyquor-cli -- web` · `cargo fmt --all --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --workspace` · `cargo tauri build` (desktop), `pnpm --filter @zyquor/web build` (web renderer only).

## Next Steps

Finishing the Rust migration (details: `docs/rust-migration.md`):

- M4: `zyquor-browser` is ported (chromiumoxide CDP session + `CdpPage` primitives, login detection, feed fetchers, composer, delete flow, launch state, Chrome launcher) but not live-tested against X yet — that needs the human ask before live CDP runs.
- M5: `apps/api` + `apps/worker` ported 2026-11-07 (axum API with all 17 TS route modules incl. jobs prepare/post/retry, ingest, drafts, replies/mentions; worker poll loop 1:1). Live-smoked against a seeded account: `/health`, `/system/status`, `/worker/status`, `/performance`, `/history/analysis`, `/onboarding/status`, `/generation` all return TS-shaped JSON, and the worker drives heartbeat → ingest async → recover-stale end-to-end (including a fix where `POST /jobs/recover-stale` 415'd on an empty body, and ingest now runs on a second DB connection so the proxy mutex never stalls).
- M6: Tauri v2 desktop shell (`apps/desktop`, `zyquor-desktop`) with the same IPC surface as Electron — settings/log/chrome/controls modules, API on port 0 + worker bring-up, tray, window, headless smoke passing. M7: keep React (`apps/web`) — verified against the Rust stack, decision recorded in `docs/rust-migration.md`.
- M8: `apps/cli` (`zyquor`) ports all 15 operational subcommands; `scripts/`, `packages/`, and the TS Electron sources are deleted. Live CDP smoke: Chrome launched via `zyquor open-profile` (CDP protocol 1.3 on 9222), `zyquor check-login` degrades gracefully without an X session. A full X login/post round-trip still requires your manual X login and explicit ask per housekeeping rules.
- Storage parity gaps (from `docs/rust-migration.md`): align `deleteAccount` behaviour (the Rust version also deletes knowledge entries and ingest configs; the TypeScript one does not) before parity testing account deletion. (The legacy null-`text_hash` regression test is deferred under the test policy.)

Verified gaps not yet in the tree:

- Web UI cannot edit per-account limits, quiet hours, or profile assignment; the Accounts panel only toggles `enabled` and deletes (`apps/web/src/components/AccountsPanel.tsx`). `PATCH /accounts/:id` already accepts those fields.
- No end-to-end test suite; voice input is also deferred (unit and API-workflow tests plus the smoke scripts exist).

Already in the tree and not pending: account creation (`POST /accounts`, "Add account" form), schedule clearing (`PATCH /jobs/:id` accepts `scheduledFor: null`), shuffled `POST /jobs/post-ready`, the quality-gate-failures panel in Compose, app icon + Azure Trusted Signing for Windows releases (`docs/code-signing.md`), `safeStorage`-encrypted API keys, and `electron-updater` auto-update.

# Delegation Rules

You are the **coordinator**: design, decide, review, land. Delegate hands-on execution to opencode CLI agents run as background jobs: `opencode run --model opencode/crouton-alpha-free#max --auto "<work order>"`, with `opencode/pulse-alpha-free#max` as the alternate. One file per work order: these free models lose the thread on multi-file prompts, so split the task and verify each result.

- If your prompt starts with `ROLE: EXECUTOR` — or you were spawned by another agent — you are an **executor**: do the work order yourself, **never spawn subagents**; report blockers instead of delegating. Coordinators start every executor prompt with `ROLE: EXECUTOR — do the work yourself; do not spawn subagents.`
- Delegate (default for hands-on work): implementation from a frozen spec; refactors; migrations; bug fixes and CI/lint/type failures; tests; dependency bumps; read-heavy exploration (fan out parallel executors, each returns a distilled summary); git mechanics after the coordinator decides to land.
- Keep in the coordinator: design, architecture, naming, UX judgment; tiny edits (~<20 lines); session tools (MCP, secrets), releases/publishes; the land decision and review of all executor output.
- How: freeze the spec as a md file in `/tasks` for complex work (executor prompts reference it); small work gets the full work order inline. Executor prompts are self-contained. Review output before accepting; re-delegate failures with the error context. Heuristic: prompt reads as a work order → delegate; writing it forces decisions → coordinator.
