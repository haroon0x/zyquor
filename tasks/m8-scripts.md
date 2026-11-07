# M8 — scripts → `zyquor-cli` + retire pnpm (frozen spec)

Exit: the web UI and the smoke scripts run against the Rust API with no
client changes. `pnpm`/TypeScript is retired: scripts become Rust binaries
in a new `apps/cli` crate, its bin named `zyquor` (same CLI name as
`scripts/zyquor.mjs`).

## Source surface (scripts/, 24 files, 3520 lines)

Classify per file (decision rationale per file is part of the deliverable):

| Script | Lines | Disposition |
|---|---|---|
| `zyquor.mjs` | 311 | port → `zyquor` subcommands `start`/`api`/`web`/`worker`/`status` (dev runner) |
| `post-loop.mjs` | 420 | port → `zyquor post-loop` |
| `reply-loop.mjs` | 415 | port → `zyquor reply-loop` |
| `overseer.mjs` | 269 | port → `zyquor overseer` |
| `backfill-profile-timeline.mjs` | 136 | port → `zyquor backfill-timeline` (runs fetch timeline for an account and saves `data/backfill.jsonl`) |
| `poll-x-mentions.mjs` | 158 | port → `zyquor poll-mentions` (one mentions fetch, prints JSON) |
| `open-x-profile-cdp.mjs` | 122 | port → `zyquor open-profile` (=ensure_browser_cdp + wait) |
| `open-x-profile.mjs` | 37 | port → same subcommand with manual=false? (CdpPage open without close) |
| `open-x-profile-manual.mjs` | 62 | port → `zyquor open-profile --manual` (stays open; waits for Enter then resolves) |
| `check-x-login.mjs` | 41 | port → `zyquor check-login` (prints handle, exit 1 when logged out) |
| `seed-business-account.mjs` | 168 | port → `zyquor seed-account` (creates account + ingest config scaffolding) |
| `propose-lessons.mjs` | 167 | port → `zyquor lessons` |
| `smoke.mjs` | 142 | check vs Rust parity harness: RETIRE (covered) |
| `smoke-app.mjs` | 77 | check vs `zyquor-desktop -- --headless-smoke`: RETIRE |
| `smoke-generation.mjs` | 45 | port to `zyquor smoke-generation` (calls live generation provider, prints JSON) |
| `smoke-http.mjs` | 203 | RETIRE — tests @zyquor/storage sqlite; Rust storage tests cover |
| `test-adapters.mjs` | 162 | RETIRE — Rust adapter tests cover |
| `tweet-harness.mjs` | 75 | RETIRE — Rust gen tests cover |
| `tweet-eval.mjs` | 193 | port → `zyquor tweet-eval` (evaluates samples; read file) |
| `verify-spacing.mjs` | 85 | RETIRE — `zyquor_core::spacing` tests cover |
| `prompt-parity.mjs` | 109 | RETIRE if the Rust parity fixture covers its cases — check the fixture names first; if a case is missing, add the fixture in the Rust crate instead of porting this script |
| `prepack-zyq.mjs` | 71 | RETIRE — Tauri packaging doesn't need symlink resolution |
| `bootstrap.mjs` | 8 | RETIRE (was a TS runner bootstrap; Rust binary needs none) |
| `load-env.mjs` | 44 | RETIRE — `zyquor_core::paths::load_dot_env` covers |

## Layout (`apps/cli/`)

- `Cargo.toml` — package `zyquor-cli`, bin `zyquor`. Deps: clap-free argument parsing (mirror `zyquor.mjs`' argv style with hand-rolled `std::env::args` + small helpers; DO NOT add clap), `zyquor-core, zyquor-storage, zyquor-browser, zyquor-accounts, zyquor-api, zyquor-worker` (for `start/api/worker` subcommands), tokio, serde/serde_json, reqwest, chrono.
- `src/main.rs` + modules (`cli.rs`, `post_loop.rs`, `reply_loop.rs`, `overseer.rs`, `backfill.rs`, `mentions.rs`, `profile.rs`, `seed.rs`, `lessons.rs`, `eval.rs`, `generation.rs`, `start.rs` or direct).
- Add `"apps/cli"` to root workspace `members` (CHANGE ONLY that line in root Cargo.toml).
- Subcommand conventions (mirror the `.mjs` arg parsing exactly — unknown flags: strict; `--once`/`--dry`/`--force`/`--help` honored):
  - `zyquor start` — start API (in-process via zyquor_api) + worker + web dev (spawn vite dev server when `apps/web` exists; else print path) — mirroring `zyquor.mjs` "start" (apiPort env: `ZYQUOR_API_PORT_OVERRIDE` else 3001, apiUrl similarly, cdpUrl/profileDir envs).
  - `zyquor api` — API only. `zyquor worker` — worker only (ZYQUOR_RUN_WORKER guard from apps/worker — read `apps/worker/src/main.rs` and reuse `start_worker` directly with options from env). `zyquor web` — vite dev server spawn.
  - `zyquor post-loop` / `reply-loop` / `overseer` — HTTP clients against `ZYQUOR_API_URL` (matching TS env defaults). All scheduling env reads with TS defaults. Posting/loops REQUIRE `ZYQUOR_ENABLE_BROWSER_PREPARE=1` guard parity: the .mjs ran regardless; the Rust port must require the env flag to approve/post (matches house rule "enabling browser lanes requires explicit human ask" — scripts are user-run so they keep their TS semantics but print a banner when disabled).
  - `zyquor open-profile` — uses zyquor_browser::launch…/ensure + injected profile dir resolution (`ZYQUOR_X_PROFILE_DIR` env like zyquor.mjs), `--manual` waits for Enter, non-manual verifies CDP up then exits.
  - `zyquor check-login` — per-profile check via zyquor_browser Session::connect + check_x_login; exit 0 only when logged in, prints `{handle, loggedIn}` JSON.
  - `zyquor backfill-timeline` — fetch_account_timeline + append `data/backfill.jsonl` records.
  - `zyquor poll-mentions` — fetch mentions via CDP once, prints JSON.
  - `zyquor seed-account` — creates account + ingest config (business name via args/env per TS).
  - `zyquor lessons` — propose lessons via generation provider (vs propose-lessons.mjs).
  - `zyquor tweet-eval` — per tweet-eval.mjs.
  - `zyquor smoke-generation` — live generation probe (mirrors smoke-generation.mjs output shape).
- Unity of behavior: machine-checkable outputs (JSON shapes) identical to TS.

## Retirement

- Remove `scripts/*.mjs` ONLY after the port of that script passes verification; TS packages (`packages/*`, `apps/api`, `apps/worker`, `apps/desktop/src`, `apps/web`) are NOT deleted in this milestone (they stay until M8 parity acceptance — delete only scripts/, pnpm-workspace.yaml root scripts, and package.json files of retired packages, keeping `apps/web/dist` building).
- STOP: before deleting anything, run the FULL verification (fmt/clippy/test + pnpm check/test). Then delete: `scripts/`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/` (core, accounts, storage, generation, adapters, automation, browser), `apps/api`, `apps/worker`, `apps/desktop/src` (TS Electron main) + `apps/desktop/package.json` + `apps/desktop/dist` (stale) + `apps/web/package.json`? NO — web is React and stays (M7 decision: React kept as the renderer; its build stays behind vite). M8 after that: `pnpm` gone.
- Report which scripts were retired with reasons instead of ports.

## Verification

- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (all green; add unit tests for pure helpers).
- `zyquor smoke-generation` live run against the local ollama if available (if provider missing, document "skipped — provider not present"); `zyquor check-login` must surface "not logged in" gracefully when Chrome is absent.
- After deleting, run `pnpm --version` check: ensure NO script references remain; `git status` must show deletions only under scripts/scripts-related files. DO NOT touch docs or `apps/desktop/**`, `apps/web/**`, or `crates/**`, `apps/api/**`, `apps/worker/**`.
