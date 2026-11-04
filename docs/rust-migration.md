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
| Desktop shell      | Electron                    | Tauri v2                             |
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
| M3 — generation / adapters / automation | partial | `zyquor-generation`: config resolution, prompt/harness assembly (8 request shapes × 4 builders, byte-identical to TypeScript), deterministic quality scoring and text post-processing, and answer parsing (`parse.rs`) (29 tests). Provider clients and `refine.ts` are not ported. `zyquor-adapters` and `zyquor-automation` are not started. OpenRouter provider removed from both stacks. |
| M4 — browser | pending | |
| M5 — api / worker | pending | |
| M6 — desktop (Tauri) | pending | |
| M7 — web | pending | |
| M8 — scripts, retire pnpm | pending | |

The TypeScript tree still runs the product and the Rust workspace passes 93
tests. No package has been retired yet; the deliberate removals above are
already applied in both stacks.

### Known gaps in `zyquor-storage`

Not ported yet:

- ~~The JSON fallback repository~~ — **does not exist.** `CLAUDE.md` and older
  docs claimed a `data/app.json` fallback; the code has only `sqlite.ts`. That
  documentation was stale and has been corrected. Nothing to port.
- `hasPostHistoryTextHash` covers the fingerprint lookup plus the legacy
  null-`text_hash` scan, but there is no test for the legacy branch yet: a
  regression test needs a row inserted with a null hash.
- `deleteAccount` also removes knowledge entries and ingest configs; the
  TypeScript version does not delete knowledge entries, so behaviour differs
  slightly (the Rust version cleans up more). Align these before parity
  testing account deletion.

### Known gaps in `zyquor-generation`

- `parse.rs` is ported (`parse_candidate_texts`, `candidates_from_text`,
  `parse_json_candidate_texts`, `is_no_candidates_error`, `as_text`, plus the
  private `is_grounded_candidate` / `strip_generated_urls` helpers) but has no
  Rust unit tests and no parity harness. Prompt assembly and quality scoring
  are covered; parsing needs fixtures before the crate can claim parity.

## Milestones

Each milestone ends with a green `cargo test` and a parity check against the
TypeScript implementation.

- **M0 — Scaffold.** `Cargo.toml` workspace, `rust-toolchain.toml`, CI job for
  `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`. Exit: builds
  empty crates.
- **M1 — `zyquor-core`.** Domain constants, statuses and transitions, path
  rules, spacing. Port `index.ts`, `state.ts`, `paths.ts`, `spacing.ts` plus
  their three test files. Exit: all core tests pass in Rust.
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
- **M6 — `apps/desktop`.** Tauri shell replacing Electron, same IPC surface.
- **M7 — `apps/web`.** Frontend decision and port (see below).
- **M8 — Scripts and services.** Port `scripts/*.mjs` to binaries; retire the
  pnpm workspace.

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

`apps/web` is React + Vite (~4k lines). Two options, decided at M7:

- **Keep the React UI as-is** and have it talk to the Rust API. Fastest, and
  leaves one non-Rust component in the repo.
- **Port to Leptos or Yew** for a fully Rust stack. Larger effort, and the UI
  code is the least costly to keep as-is.

The migration plan of record is to keep React through M6, then decide at M7
based on how much UI-specific logic has already moved into the Rust API.

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
