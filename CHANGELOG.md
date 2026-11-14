# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Live generation-provider hot-swap: `PATCH /generation` now rebuilds and swaps
  the provider in place (`LiveGenerationProvider` holds the merged env snapshot
  + provider behind an `RwLock`), persists `data/generation.json`, and keeps
  `GET /generation`, `/health`, and `/system/status` in step. The generation
  keys of `PATCH /settings` hot-swap the same way. No restart required.
- Persistent desktop settings: `DesktopSettingsPlane` is injected into the API
  by the Tauri shell (over `settings.json`), so `GET/PATCH /settings`,
  `POST /system/posting`, and the `posting` fields of `GET /system/status`
  survive a restart. The standalone API keeps an in-process fallback.
- `autoApproveSourcePackets` now gates source-packet auto-approval
  (`enablePost && setting`), matching the retired `source-packets.ts`.
- End-to-end HTTP workflow suite (`apps/api/tests/e2e_workflow.rs`, 8 tests)
  covering accounts, draft → select → approve → job, quality gates, source
  packets, ingest configs, system feedback, history, and generation reads,
  in-process with no LLM/browser/network dependency.
- `parse.rs` unit tests (13 fixtures) in `zyquor-generation`, plus
  `zyquor-storage` account-deletion parity and legacy null-`text_hash`
  regression tests.
- `zyquor outreach`: review-only Reddit/Hacker News thread finder with a local
  queue and no posting path (`docs/outreach.md`).
- Windows code signing: `docs/code-signing.md` rewritten for Tauri v2, and the
  `desktop-win` CI job has opt-in Authenticode wiring guarded on repository
  secrets so unsigned builds still work without a certificate.

- Desktop control plane over HTTP: the Tauri shell injects a
  `DesktopControlPlane` into the Rust API, restoring the web UI's System panel
  (`GET /system/logs`, `POST /system/worker/pause`, `POST /system/chrome/close`,
  `POST /system/stop-all`, `POST /system/quit`, `POST /system/restart`) and the
  `desktop` / `worker.paused` fields of `GET /system/status`. Response shapes
  and defaults follow the retired `system.ts`; the standalone API still answers
  404 for the desktop-only routes. Covered by `apps/api/tests/desktop_control.rs`
  and the extended `--headless-smoke`.
- `POST /system/posting` now round-trips `enablePrepare`, `enablePost`, and
  `autoApproveSourcePackets` through the settings store instead of returning a
  hardcoded `false`.
- `.env` is loaded again: every Rust entry point calls
  `zyquor_core::dotenv::load()` before reading config (existing process
  variables still win). The Rust port had dropped the TypeScript `dotenv`
  import, so a `cp .env.example .env` setup was silently ignored.
- `zyquor start` / `zyquor web` run the Vite dev server from `apps/web`
  (`pnpm run dev`) instead of the retired root pnpm workspace filter.
- The Tauri app icons are committed under `apps/desktop/build/` (they were
  gitignored, so a clean checkout could not run `cargo tauri build`); the
  generator at `apps/desktop/scripts/` now declares its own `package.json`.
- CI: the dead pnpm `test` job is now the `apps/web` renderer job, and
  `dist-desktop-win` became `desktop-win` (`cargo tauri build`, unsigned).
- Docs: `ROADMAP.md`, `CLAUDE.md`, `AGENTS.md`, `README.md`, and
  `docs/rust-migration.md` now describe the Rust tree (the retired TypeScript
  commands, crates, and milestone states were replaced).

- Rust migration milestone M8: `apps/cli` — the `zyquor` binary ports all 15
  operational subcommands (start/api/worker/web, post-loop, reply-loop,
  overseer, open-profile + --manual, check-login, backfill-timeline,
  poll-mentions, seed-account, lessons, tweet-eval, smoke-generation) with
  hand-rolled argv parsing (no new deps). Retired: `scripts/*.mjs`,
  `packages/*`, root `package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml`,
  the TS sources under `apps/api/src/*.ts`, `apps/worker/src/*.ts` and
  `apps/desktop/src/*.ts` (incl. the Electron sources), plus Electron
  packaging files under `apps/desktop/` (`electron-builder.yml`/`azure.cjs`,
  `scripts/`, tsconfigs). Kept: `apps/web` (React renderer — M7 decision),
  `apps/desktop/scripts/make-icons.mjs` (static icon asset generator; run
  once with `node` before `cargo tauri build`). Live CDP smoke 2026-11-08:
  `cargo run -p zyquor-cli -- open-profile` launched Chrome 147 with CDP
  protocol 1.3 on 9222 against the dedicated profile; `check-login`
  degrades to `{loggedIn: false}` without an X session.
  `cargo test --workspace`: 172 Rust tests pass.

- Rust migration milestone M5: `apps/api` (axum server porting all 17
  TypeScript route modules — accounts, system, batches, browser, drafts
  (incl. generate/research/evaluate), generation, history,
  ingest (sync/async), jobs (incl. prepare/post/verify-then-retry),
  knowledge, onboarding, performance (incl. tweet-performance refresh),
  replies (incl. mentions scans), settings, source-packets, style-profiles,
  system-feedback, worker) plus the `lib/*` helpers it needs, and
  `apps/worker` (the poll loop first-flighted against the Rust API:
  heartbeat, ingest, recover-stale, approved-job runs, performance and
  mentions lanes, worker lock). Live smoke verified `/health`,
  `/system/status`, `/worker/status`, `/performance` (+ refresh),
  `/history/analysis`, `/onboarding/status`, `/generation` returning the
  same JSON shapes as the TypeScript API. M5 gaps at the time: the
  desktop-only `system/*` routes needed a control-plane injection (added
  2026-11-12), the ingest/packet-draft flows run on a second SQLite
  connection so the proxy mutex never stalls, and the live generation
  provider is not hot-swappable (`PATCH /generation` persists + validates;
  restart applies). 122 Rust tests pass.

- Rust migration milestone M4: the full `zyquor-browser` crate on
  chromiumoxide CDP (session + page layer, per-profile Chrome launch with
  WSL and detached-process handling, per-profile launch state, login
  detection, all five feed feeders, the composer flow with
  caller-gated post click and verified permalink, the delete flow,
  trace-event failure artifacts). Playwright's actionability waits are
  reimplemented over `Runtime.evaluate` polls; the cross-frame stability
  check is a documented single-poll wait.

- Rust migration milestone M3 complete: `zyquor-generation` (provider
  clients behind a `Fetch` seam + shared CLI spawn/capture runner + refine
  loop), all 19 `zyquor-adapters` source adapters with the aggregator and
  health tracking, the Goldfish MCP adapter, and the full
  `zyquor-automation` ingest engine (packet drafting, tweet-type routing,
  quality gates, performance aggregation).
- Deep-module design pass (2026-11-07): one module per concept with a
  minimal surface (`deps` owns env-derived config, `packet` owns packet
  derivation, `routing` owns tweet-type decisions, `quality` owns the
  gates, `performance` owns engagement math, `topic` owns topic identity).
  `selection.ts` merged into its owners; `pickTweetType` (domain analysis
  showed it has no production caller) removed rather than ported.
- Tauri v2 locked in as the M6 desktop-shell decision (previously undecided
  prose).

## [0.1.0] - 2026-11-04

Initial public release. Local-first X posting assistant: draft, review, approve,
and post through a dedicated Chrome profile, with SQLite persistence and no
account credentials leaving the machine.

### Added

- Three creation lanes: `single` (one idea, generated candidates, review and
  approve), `batch` (one idea per line, multiple jobs with optional schedule
  spacing), and `yolo` (one candidate generated and approved as `autopost`).
- Source ingestion and source packets: deterministic adapters with a 48-hour
  freshness filter, host caps, duplicate suppression, packet drafting, and
  feedback-aware regeneration (`/source-packets/:id/regenerate`).
- Reply lane, drafting only: mention feed and scanning, `POST /replies/from-url`
  for one target URL with best-of-N candidates, and a capped mentions
  auto-approve gate that approves only text clearing the deterministic quality
  floor (`ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP`, default 3).
- Browser prepare and post behind `ZYQUOR_ENABLE_BROWSER_PREPARE` and
  `ZYQUOR_ENABLE_BROWSER_POST`, both off unless set to `1`, with per-profile
  concurrent posting: one Chrome profile and one CDP port per account, resolved
  by `perProfileCdpUrl` in `packages/core`.
- Electron 37 desktop app (`apps/desktop`), tray-resident, running the API,
  worker, and web UI in-process, with `settings.json` in the data root, batched
  file logging, `safeStorage` encryption for the Gemini API key, an NSIS Windows
  installer, and Azure Trusted Signing support in CI.
- SQLite persistence through `node:sqlite` (`packages/storage`) covering
  accounts, style profiles, drafts, jobs, attempts, source packets, ingest
  configs, post history, tweet measurements, feedback, and knowledge entries.
- Deterministic quality floor in `scoreTweetQuality`
  (`packages/generation/src/quality.ts`): additive scoring with
  `ZYQUOR_QUALITY_MIN` (default 7) for posts and a reply floor of 5, used as a
  gate rather than a ranker. No LLM judge in the pipeline.
- Rust workspace scaffolding for the migration: `crates/zyquor-core` (domain
  types, lifecycle transitions, path rules, post spacing, reply-target parsing),
  `crates/zyquor-accounts` (account config and profile safety),
  `crates/zyquor-storage` (the SQLite repository surface, schema, column
  migrations, first-run seeding), and `crates/zyquor-generation` (config
  resolution, deterministic quality scoring, prompt assembly, harness renderers,
  output parsing). Each ported crate ships parity harnesses against the
  TypeScript implementation, including `scripts/prompt-parity.mjs`.
- Agent-facing approval screening: `POST /drafts/:id/approve` with
  `screened: true` rejects text that fails `isCleanTweetText`, the quality
  floor, or the raw length check.

### Changed

- `deleteAccount` matches the retired TypeScript table list exactly (it no
  longer deletes `knowledge_entries`); deleting an account that still owns a
  knowledge entry fails and rolls back through the non-cascading FK, exactly as
  the TypeScript implementation behaved.
- Docs tell the truth about the finished state: `ROADMAP.md`, `CLAUDE.md`,
  `docs/rust-migration.md`, and `docs/architecture.md` now record the
  completed migration, the landed 2026-11-14 work, and the remaining product
  decisions (live X acceptance, signing certificate, `deleteAccount` vs
  knowledge entries, `xai-news` date regex).

- Approvals write a normalized text fingerprint and reject duplicate text for
  the same account; the pre-approval duplicate check queries approved drafts
  directly.
- Browser failures are persisted as job attempt state with artifacts instead of
  being logged to the console only, and a failed post is never retried
  automatically.
- `POST /jobs/:id/retry` verifies first: it scans the target thread and the
  account's `/with_replies` timeline, marks the job posted if the reply is found,
  and only otherwise re-arms `failed -> approved` and reposts through the gated
  path.

### Removed

- Five legacy tweet types (`news_context`, `lesson`, `tool`, `article_summary`,
  `hiring`). Existing rows are folded on database open: `lesson` becomes
  `guide`, the rest become `useful_info`. `TweetType` is now the six supported
  types in both stacks.
- The OpenRouter generation provider, from both the TypeScript and Rust trees,
  including the provider lists, settings surfaces, `.env.example`, and the
  `auto` provider preference (now Gemini, then Ollama). The OpenRouter public
  models endpoint is still used by `packages/adapters/src/model-releases.ts` for
  source ingestion only.
- The `content_fingerprints` table. It is dropped on database open and replaced
  by `drafts.text_hash`; `post_history.text_hash` remains the posted-text index.

### Fixed

- Replies record their own status URL as the permalink instead of the parent
  tweet's URL.
- Dialog dismissers attach to every browser page, so a leftover composer no
  longer crashes the API through an unhandled `beforeunload` rejection.
- The composer is focused directly instead of through `editor.click()`, so
  prepare no longer stalls on Playwright's pointer actionability checks when the
  browser window is minimized or fully occluded.
- `scripts/reply-loop.mjs` retries failed drafts after
  `ZYQUOR_REPLY_LOOP_RETRY_HOURS` instead of marking them seen forever.
