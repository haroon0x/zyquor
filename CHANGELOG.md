# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
