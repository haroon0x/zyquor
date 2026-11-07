# Rust Migration Plan

> **Status: in progress.** Zyquor is being migrated from TypeScript to Rust.
> The TypeScript implementation remains the running system until each Rust
> crate reaches parity. This document is the source of truth for the target
> architecture and the migration sequence.

## Goal

Move the whole project — all packages, the API, the worker, the desktop shell,
and the web UI — onto Rust, keeping behaviour identical: same HTTP surface,
same SQLite persistence, same generation providers, same browser
prepare/post flow, same safety rails.

## Non-goals

- No behaviour changes ride along with the port. A migration commit that also
  changes behaviour is rejected.
- No new features, providers, or endpoints until the port is complete.
- No schema changes to the persisted data. Existing `data/app.sqlite` must load
  unchanged.

## Scope inventory

Measured on the `rust-migration` branch at the start of the work:

| Path               | Files | Lines |
| ------------------ | ----: | ----: |
| `apps/api`         |    61 |  9045 |
| `apps/worker`      |     2 |  1755 |
| `apps/web`         |    25 |  4047 |
| `apps/desktop`     |     8 |  1988 |
| `packages/adapters`|    27 |  3408 |
| `packages/generation` | 16 |  2915 |
| `packages/storage` |    10 |  2766 |
| `packages/browser` |     3 |  2248 |
| `packages/automation` | 12 |  2132 |
| `packages/core`    |     7 |  1431 |
| `packages/accounts`|     2 |    45 |
| **Total**          |**~173**|**~29.7k**|

Plus `scripts/` (`.mjs` tooling), which is ported last.

## Deliberate removals

Anything dropped instead of ported is listed here so it is not silently
resurrected by a later agent.

- **OpenRouter generation provider** (both stacks). Removed from
  `packages/generation`, the provider list in `@zyquor/core`, the API/web/desktop
  settings surfaces, `.env.example`, and the Rust `zyquor-generation` crate.
  `auto` provider selection now prefers Gemini, then Ollama.
  Note: `packages/adapters/src/model-releases.ts` still calls OpenRouter's
  public *models* endpoint as a source of model-release data. That is source
  ingestion, not LLM generation, and it stays until a replacement source is
  picked.
- **`services/`** (demo-checker, crawl4ai Python service). The optional external
  Crawl4AI REST API is still supported through `CRAWL4AI_API_URL`; the bundled
  Python service and its npm scripts (`dev:crawl4ai`, `x:demo-check`) are gone.
- **Five legacy tweet types** (`news_context`, `lesson`, `tool`,
  `article_summary`, `hiring`). `TweetType` in both stacks is now the six
  supported types. Existing rows in `post_history`, `source_packets` and
  `tweet_measurements` are folded on database open: all map to `useful_info`
  except `lesson`, which maps to `guide`. Retired values in an
  `ingest_configs.tweet_type_mix_json` are ignored by `pickTweetType`; rewrite
  a config via the UI/API if its mix was mostly legacy weights.
- **`content_fingerprints`.** Collapsed into `drafts.text_hash` (set on
  approval); the table is dropped on open. `post_history.text_hash` remains the
  "have I posted this already" index, and the pre-approval duplicate check now
  queries approved drafts directly.

## Target layout

A single Cargo workspace at the repo root:

```text
Cargo.toml                 # [workspace] members + shared dependency versions
crates/
  zyquor-core/             # <- packages/core      domain types, state machine, paths, spacing
  zyquor-accounts/         # <- packages/accounts  account config, profile safety
  zyquor-storage/          # <- packages/storage   SQLite repositories
  zyquor-adapters/         # <- packages/adapters  source adapters, health, crawl4ai
  zyquor-generation/       # <- packages/generation provider clients, prompts, quality
  zyquor-automation/       # <- packages/automation ingest selection, source-packet drafting
  zyquor-browser/          # <- packages/browser   CDP prepare/post
apps/
  api/                     # <- apps/api           axum HTTP server
  worker/                  # <- apps/worker        background polling
  desktop/                 # <- apps/desktop       Tauri shell (was Electron)
  web/                     # <- apps/web           frontend (see "Web UI" below)
```

Crate dependency direction mirrors the TypeScript packages exactly:

```text
core <- accounts, storage, generation
core <- adapters <- automation
core <- browser
automation -> adapters, core, generation, storage
api -> accounts, adapters, automation, browser, core, generation, storage
worker -> core, storage
```

## Mapping

| Concern            | TypeScript today            | Rust target                          |
| ------------------ | --------------------------- | ------------------------------------ |
| Runtime            | Node 24                     | Rust 2024 edition, tokio             |
| Schemas/validation | zod                         | serde + `validator`/hand-written     |
| HTTP server        | Fastify                     | axum + tower-http                    |
| Persistence        | `node:sqlite` + drizzle     | rusqlite (bundled) + hand-written SQL |
| Browser automation | playwright-core (CDP)       | chromiumoxide (CDP)                  |
| Desktop shell      | Electron                    | Tauri v2 (decided 2026-11-06)        |
| Frontend           | React + Vite                | see "Web UI"                         |
| Tests              | vitest                      | `cargo test` + parity fixtures       |
| Config             | `.env` via process env      | dotenvy, same variable names         |
| Scripts            | `.mjs` + tsx                | `cargo run --bin ...` subcommands    |

## Status

| Milestone | State | Notes |
| --------- | ----- | ----- |
| M0 — Scaffold | done | `Cargo.toml` workspace, `rust-toolchain.toml`, Rust CI job (fmt, clippy, test). |
| M1 — `zyquor-core` | done | Domain enums, lifecycle transitions, path rules, post spacing, reply-target parsing. 35 tests; parity harness matches TypeScript on 96 gate/transition cases and 11 CDP-URL cases. |
| M2 — `zyquor-storage` + `zyquor-accounts` | partial (SQLite complete) | `zyquor-accounts` ported (6 tests). `zyquor-storage` ports the full SQLite `ZyquorRepository` surface — schema, column migrations, first-run seeding, accounts, style profiles, system feedback, knowledge entries, drafts, jobs, attempts, source packets, ingest runs/configs, post history, tweet measurements (23 tests). Verified cross-implementation: a database written by the TypeScript repository is read back by the Rust one with matching draft, job, and history records. No remaining repository surface. |
| M3 — generation / adapters / automation | complete | `zyquor-generation` is complete: config resolution, prompt/harness assembly (8 request shapes × 4 builders, byte-identical to TypeScript), deterministic quality scoring and text post-processing, answer parsing (`parse.rs`), the provider clients (`command-code`, `opencode` with its failover ladder, `gemini`, `ollama`) behind a `Fetch` seam plus a shared spawn/capture runner for the CLIs, the refine loop, and the `create_generation_provider_from_env` factory. `zyquor-adapters` is complete: all 19 source adapters + the aggregator + health tracking + the Goldfish MCP adapter behind a `Fetch`/`CrawlService` seam (new modules `types.rs`, `fetch.rs`, `xml_util.rs`, `dates.rs`); Date.parse-compatible date helpers and XML/HTML helpers shared per-crate. `zyquor-automation` is complete: the ingest engine, packet/draft derivation, tweet-type routing (daily caps, rolling window, hash selection), post-quality gates, performance aggregation, and the shared `AutomationDeps` env bundle. Known gap from the port: the TypeScript `xai-news.ts` parses `firstMatch` group 1 (the 3-letter month fraction of the regex, e.g. "Jan"), so no xai-news item has ever passed the `published` check; the Rust port reproduces that bug by contract (reported separately; see "Known gaps"). |
| M4 — browser | partial | `zyquor-browser` ported: chromiumoxide CDP session layer (page selection, dialog dismissal, owned-tab cleanup), `CdpPage` primitives (visible/actionability waits, hit-test clicks, text insertion), login detection + handle resolution, all five feed fetchers (timeline, mentions, home feed, tweet, performance) with scroll-and-collect machinery, the composer flow (open/type/verify + caller-gated click → verified permalink), the delete flow, per-profile launch state, and the Chrome launcher with WSL/detached handling. Deliberate gaps (see "Known gaps"): the Playwright cross-frame stability check is reduced to scroll+one poll wait; `prepare-*.zip` trace artifacts are trace-events JSON dumps; the non-CDP `launchPersistentContext` fallback is not ported. Not yet live-tested against X (the human-ask rule). |
| M5 — api / worker | complete | `zyquor-api` (axum 0.8 + tower-http 0.6) ports all 17 TS route modules (accounts, system, batches, browser, drafts, generation, history, ingest, jobs incl. prepare/post/retry, knowledge, onboarding, performance, replies incl. mentions scans, settings, source-packets, style-profiles, system-feedback, worker) plus the `lib/*` helpers (`browser`, `daily-limit`, `media`, `post-process`, `post-browser-job`, `post-history-snapshot`, `stale-jobs`, `retry-job`, `history`, `tweet-performance`, `feedback-notebook`). `zyquor-worker` ports the TS poll loop 1:1 (approved jobs by account with quiet hours/spacing backfill, ingest, performance, mentions lanes, heartbeats, worker lock). Storage gained the handful of repository queries the routes need (`delete_job`, `list_jobs_by_draft_id`, pending/quality-gate draft lists, post-history counts, etc.). Smoke-tested live against a seeded account: health/status/worker/performance/history/onboarding/generation all respond with TS shapes, and the worker drives heartbeat → ingest async → recover-stale end-to-end (the TS daily-cap/post flows stay behind `ZYQUOR_ENABLE_BROWSER_PREPARE/POST`, and live CDP against X still needs the human ask per housekeeping rules). Test count: 122. |
| M6 — desktop | complete (Tauri v2 shell) | `zyquor-desktop` (Tauri v2, `apps/desktop/`) replaces Electron: `settings.rs` (settings.json + env map, plaintext-keys gap recorded), `log.rs` (buffered 5 MiB rotation logger), `chrome.rs` (per-profile CDP launch/close state), `controls.rs` (desktopControl/status/logTail/quit/restart/pause chrome-close, tray tooltip, shutdown sequence), `main.rs` (API on port 0 + worker bring-up, single-instance, autostart, window with `window.zyquor` init script, 60 s failed-job tooltip poll, headless-smoke). Headless smoke exits 0 without Chrome (`OK: /accounts → 200`, `OK: /worker/status → 200`). Update channel stubbed (Tauri updater needs signing keys); `startWithWindows` via autostart plugin; safeStorage keys are plaintext (`enc:v1:` legacy values still parsed); `--headless-smoke` skips the single-instance lock. Test count: 158. |
| M7 — web | complete (decision) | **Keep React** (see "Web UI" below): the UI is web content inside the Tauri webview, its only desktop surface `window.zyquor` is preserved. Verified: `pnpm --filter @zyquor/web build` (tsc + vite, 289 kB JS + 32 kB CSS) produces the dist the Tauri shell consumes; both API and UI were exercised against the Rust stack in M5/M6.
| M8 — scripts, retire pnpm | in progress | Port `scripts/*.mjs` to the `zyquor` CLI (`apps/cli`, hand-rolled argv parser, no new deps). Retirement order in `tasks/m8-scripts.md` (port: zyquor.mjs, post-loop, reply-loop, overseer, backfill-timeline, poll-mentions, open-profile ×3, check-login, seed-account, lessons, tweet-eval, smoke-generation; retire: smoke ×4, test-adapters, tweet-harness, verify-spacing, prepack-zyq, bootstrap, load-env, prompt-parity if fixture-covered). pnpm workspace retires only after every script's Rust equivalent passes verification. |

The TypeScript tree still runs the product and the Rust workspace passes
122 tests. No package has been retired yet; the deliberate removals above are
already applied in both stacks.

### Known gaps in `zyquor-api` / `zyquor-worker`

- The TS `desktopSettings`/`desktopControl` injections have no Rust
  counterpart yet: `POST /system/posting`'s `autoApproveSourcePackets` reads
  the settings-store value (`false` when unset, matching the TS desktop-absent
  `=== true` check), `/system/logs|worker/pause|chrome/close|stop-all|quit|
  restart` are not registered (they live behind `deps.desktopControl`, which
  the desktop app owns), and `GET /settings`/`PATCH /settings` keep values in
  a process-level store (browser-flag side effects are wired to the real
  `BrowserDeps`). The `PATCH /generation` route validates and persists the
  saved config but cannot swap the live `Arc<dyn DraftGenerationProvider>`
  in place (it is immutable in `AppState`); restart applies the change.
- Ingest/packet-draft run on a second SQLite connection (opened from
  `AppState::db_path`) so the shared proxy mutex is never held across a
  network-bound generation/ingest. WAL (`PRAGMA journal_mode = WAL`) is
  already on, so the two connections interleave safely.
- The TS `startWorker({ checkStartup })` test-injection dep and
  `fetchActiveAccount` (GET /browser/active consumer) are not ported:
  `check_worker_startup` is public, and the single-account rule was removed
  per AGENTS.md, making `fetchActiveAccount` dead code in TS.
- `zyquor-api` keeps the TS dep wiring by reusing `zyquor-worker`'s
  `zyquor_core::spacing::next_autopost_scheduled_for` and the Rust storage
  proxy; validation errors use the shared `{"error": "Invalid request",
  "issues": []}` shape rather than zod's per-field messages (same status and
  shape family).
- Accounts are processed sequentially in the worker (TS used `Promise.all`
  across accounts); per-account ordering, quiet hours, due/mode filtering,
  backfill, post gates, and busy-account break are preserved.

### Known gaps in `zyquor-browser`

- Playwright's cross-frame "stable" actionability check is reduced to a single
  poll wait after scroll-into-view before the hit test. Fast re-mounts of the
  React composer can still slip past on a slow first paint.
- `context.tracing.stop({ path })` zips are written as trace-events JSON
  (`prepare-<stamp>.json`) instead; the failure shows up in the path name and
  opens in devtools' trace viewer rather than Playwright's.
- The non-CDP `launchPersistentContext` fallback (used by a few scripts) is
  not ported; only the CDP path is wired, the same validation as the
  TypeScript open-path raises an explicit refusal.
- The flows are not live-tested against X yet; that needs the human ask
  ("posting/compose tasks require an explicit human ask" per housekeeping
  rules) before the CDP flows run as an acceptance check.

### Known gaps in `zyquor-adapters`

- `xai-news.ts` (TypeScript) has a latent bug: the published-date regex
  `(Jan|…|Dec)[a-z]* \d{1,2}, \d{4}` captures only the month fraction
  (e.g. `"Jan"`), which `Date.parse` rejects, so the adapter's items never
  pass its own published-date filter. The Rust port reproduces that behaviour
  (`parse_date` of the 3-letter fraction never yields items). Fix in a
  separate change once the bug is acknowledged; do not "repair" it inside a
  port commit.

### Known gaps in `zyquor-storage`

Not ported yet:

- ~~The JSON fallback repository~~ — **does not exist.** `CLAUDE.md` and older
  docs claimed a `data/app.json` fallback; the code has only `sqlite.ts`. That
  documentation was stale and has been corrected. Nothing to port.
- `hasPostHistoryTextHash` covers the fingerprint lookup plus the legacy
  null-`text_hash` scan, but there is no test for the legacy branch yet: a
  regression test needs a row inserted with a null hash; deferred under the
  test policy, not a blocker.
- `deleteAccount` also removes knowledge entries and ingest configs; the
  TypeScript version does not delete knowledge entries, so behaviour differs
  slightly (the Rust version cleans up more). Align these before parity
  testing account deletion.

### Known gaps in `zyquor-generation`

- `parse.rs` is ported (`parse_candidate_texts`, `candidates_from_text`,
  `parse_json_candidate_texts`, `is_no_candidates_error`, `as_text`, plus the
  private `is_grounded_candidate` / `strip_generated_urls` helpers) but has no
  Rust unit tests and no parity harness. Accepted for now under the test
  policy; prompt assembly and quality scoring remain covered by the existing
  harnesses.

## Milestones

Each milestone ends with a green `cargo test` and, where a parity harness
exists, a parity check against the TypeScript implementation.

- **M0 — Scaffold.** `Cargo.toml` workspace, `rust-toolchain.toml`, CI job for
  `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`. Exit: builds
  empty crates.
- **M1 — `zyquor-core`.** Domain constants, statuses and transitions, path
  rules, spacing. Port `index.ts`, `state.ts`, `paths.ts`, `spacing.ts`.
  Exit: all core tests pass in Rust.
- **M2 — `zyquor-storage` + `zyquor-accounts`.** Repositories over rusqlite
  repositories; account config helpers. Exit: read an existing
  `data/app.sqlite` and round-trip it byte-faithfully.
- **M3 — `zyquor-generation` + `zyquor-adapters` + `zyquor-automation`.**
  Provider clients, prompt assembly, `score_tweet_quality`, source adapters,
  source packets. Exit: same draft for the same fixture prompt.
- **M4 — `zyquor-browser`.** CDP prepare/post against a dedicated profile.
  Exit: prepare succeeds on a real logged-in profile; post stays behind
  `ZYQUOR_ENABLE_BROWSER_POST`.
- **M5 — `apps/api` + `apps/worker`.** axum server exposing the identical
  route set and response shapes; worker polling loop. Exit: the web UI and
  the smoke scripts run against the Rust API with no client changes.
- **M6 — `apps/desktop`.** Tauri v2 (decided 2026-11-06) replacing Electron, same IPC surface. **Done 2026-11-08** (`zyquor-desktop`, headless-smoke exit 0).
- **M7 — `apps/web`.** Frontend decision: **keep React** (see "Web UI" below). **Done 2026-11-08.**
- **M8 — Scripts and services.** Port `scripts/*.mjs` to binaries; retire the
  pnpm workspace. In progress 2026-11-08.

## Test policy

TypeScript test files are **not** ported to Rust. Rust crates carry their own
tests, and the crate tests and parity harnesses that already exist stay and
must stay green. A ported module without Rust tests is an accepted gap —
record it under "Known gaps", but it is not a blocker for a milestone. Writing
new Rust unit tests is welcome when convenient, never required for parity.

## Parity strategy

The migration is only "done" when behaviour is provably identical, so each
crate ships with fixtures captured from the TypeScript implementation:

1. **Golden fixtures.** Record inputs/outputs from the TS code (HTTP
   responses, generated prompts, quality scores, DB rows) into
   `crates/<crate>/tests/fixtures/`.
2. **Dual-run harness.** While both implementations exist, a harness feeds the
   same fixture through both and diffs the result. Any diff fails the build.
3. **Route conformance.** `apps/api` keeps a recorded set of request/response
   pairs; the Rust server must reproduce them exactly (status, JSON body,
   headers that matter).
4. **Live smoke.** `pnpm smoke`, `pnpm smoke:http`, `pnpm smoke:adapters` are
   re-pointed at the Rust API before the TypeScript one is deleted.

Nothing is deleted from the TypeScript side until the corresponding Rust
crate passes the parity harness.

## Web UI

`apps/web` is React + Vite (~4k lines). **Decision at M7 (2026-11-08): keep
the React UI as-is.** The UI is web content served inside the Tauri webview
(`frontendDist` → `apps/web/dist`, wired in M6) and, in dev, via the Vite
dev server against the Rust API — it is not a desktop concern, the only
desktop-facing surface is `window.zyquor = { apiBaseUrl, appVersion, updates }`
(injected by Tauri), which survives by design. Porting ~4k lines of TSX to a
Rust native UI (Leptos/Yew) would rewrite the product's design system for
zero user value, and the UI's worth is its code, not its language. The
migration exit criterion — *"the web UI runs against the Rust API with no
client changes"* — is met: `pnpm --filter @zyquor/web build` produces the
dist the Tauri shell loads, and both sides were verified against the Rust
API in M5/M6.

## Browser automation note

`CLAUDE.md` previously said "Keep Rust out of the browser automation core."
That rule is superseded by this migration. The *intent* behind it still
applies and is preserved as requirements on the Rust implementation:

- Browser automation stays isolated in the `zyquor-browser` crate.
- Dedicated profiles only, under `profiles/`; never the everyday Chrome
  profile.
- No stealth, anti-detection, proxy rotation, or CAPTCHA bypass.
- No automated follows, likes, reposts, DMs, or engagement loops.
- The final post action stays explicit, gated, and logged.

## Risks

- **Browser parity** is the highest-risk item. Playwright provides selectors,
  actionability waits, and retries that raw CDP does not. The Rust crate must
  reimplement waiting/retry semantics explicitly and be tested against the
  live X composer.
- **SQLite semantics.** `node:sqlite` and rusqlite differ on type affinity and
  transaction defaults; M2 pins the exact schema and round-trips real data.
- **Desktop packaging.** Electron → Tauri changes the installer, updater, and
  code signing. `docs/code-signing.md` must be rewritten at M6.
- **Frontend.** If React is kept, the repo is not 100% Rust; this is called
  out rather than hidden.

## Verification commands

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

While both stacks exist, also run the existing TypeScript suite to prove the
baseline did not move:

```bash
pnpm check
pnpm test
```
