# Rust Migration Plan

> **Status: in progress.** Zyquor is being migrated from TypeScript to Rust.
> The TypeScript implementation remains the running system until each Rust
> crate reaches parity. This document is the source of truth for the target
> architecture and the migration sequence.

## Goal

Move the whole project — all packages, the API, the worker, the desktop shell,
and the web UI — onto Rust, keeping behaviour identical: same HTTP surface,
same SQLite/JSON persistence, same generation providers, same browser
prepare/post flow, same safety rails.

## Non-goals

- No behaviour changes ride along with the port. A migration commit that also
  changes behaviour is rejected.
- No new features, providers, or endpoints until the port is complete.
- No schema changes to the persisted data. Existing `data/app.db` and
  `data/app.json` must load unchanged.

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

Plus `scripts/` (`.mjs` tooling) and `services/`, which are ported last.

## Target layout

A single Cargo workspace at the repo root:

```text
Cargo.toml                 # [workspace] members + shared dependency versions
crates/
  zyquor-core/             # <- packages/core      domain types, state machine, paths, spacing
  zyquor-accounts/         # <- packages/accounts  account config, profile safety
  zyquor-storage/          # <- packages/storage   SQLite + JSON repositories
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
| JSON fallback      | `data/app.json`             | serde_json, same file shape          |
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
| M1 — `zyquor-core` | done | Domain enums, lifecycle transitions, path rules, post spacing, reply-target parsing. 41 tests; parity harness matches TypeScript on 96 gate/transition cases and 11 CDP-URL cases. |
| M2 — `zyquor-storage` + `zyquor-accounts` | partial (SQLite complete) | `zyquor-accounts` ported (6 tests). `zyquor-storage` ports the full SQLite `ZyquorRepository` surface — schema, column migrations, first-run seeding, accounts, style profiles, system feedback, knowledge entries, drafts, jobs, attempts, source packets, ingest runs/configs, post history, tweet measurements (23 tests). Verified cross-implementation: a database written by the TypeScript repository is read back by the Rust one with matching draft, job, and history records. Remaining: the JSON fallback repository. |
| M3 — generation / adapters / automation | pending | |
| M4 — browser | pending | |
| M5 — api / worker | pending | |
| M6 — desktop (Tauri) | pending | |
| M7 — web | pending | |
| M8 — scripts, retire pnpm | pending | |

The TypeScript tree is untouched and still runs the product. Nothing has been
removed yet.

### Known gaps in `zyquor-storage`

Not ported yet:

- The JSON fallback repository (`data/app.json`), used when `node:sqlite` is
  unavailable in the TypeScript build. The Rust build always uses SQLite, so
  this is only needed for reading data written by a JSON-fallback install.
- `hasPostHistoryTextHash` covers the fingerprint lookup plus the legacy
  null-`text_hash` scan, but there is no test for the legacy branch yet: a
  regression test needs a row inserted with a null hash.
- `deleteAccount` also removes knowledge entries and ingest configs; the
  TypeScript version does not delete knowledge entries, so behaviour differs
  slightly (the Rust version cleans up more). Align these before parity
  testing account deletion.

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
  and the JSON fallback; account config helpers. Exit: read an existing
  `data/app.db` and `data/app.json` and round-trip them byte-faithfully.
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
