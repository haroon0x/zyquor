# Development Notes

Zyquor is a Rust Cargo workspace. Everything that runs is Rust except the React renderer in `apps/web`. `docs/rust-migration.md` records how the TypeScript tree was retired; `ROADMAP.md` is the current state.

## Prerequisites

- Rust stable through `rustup`; `rust-toolchain.toml` pins the stable channel plus the `rustfmt` and `clippy` components.
- Node.js and pnpm, only for building the `apps/web` renderer.
- Chrome installed. Browser automation is direct CDP through `chromiumoxide`; no browser bundle is downloaded.
- A generation provider: the authenticated `opencode` CLI by default, or `command-code` (CLI), Gemini (API key), or Ollama (local server). `tweet-eval` additionally needs the `command-code` CLI for its judge pass.
- The Tauri v2 CLI (`cargo tauri`) for the desktop app. Run the desktop app from native Windows, never from WSL.
- An X account you are willing to post from, plus a dedicated profile under `profiles/`.

## Build and Verify

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace
```

Clippy is strict: `unwrap_used`, `expect_used`, and `panic` are denied at workspace level. Only `apps/web` uses pnpm; there is no repo-level TypeScript check or test step.

## Web Renderer

```bash
cd apps/web
pnpm install
pnpm build
```

Or from the repo root:

```bash
pnpm --dir apps/web install
pnpm --dir apps/web build
```

`pnpm build` runs `tsc --noEmit` and `vite build`; output lands in `apps/web/dist`. Tauri loads that directory (`frontendDist: ../web/dist`), so build the renderer before `cargo tauri dev` or `cargo tauri build`. For UI work, `pnpm --dir apps/web dev` serves Vite on <http://127.0.0.1:5173>.

## CLI

The operational binary is `zyquor` (`apps/cli`). It accepts the commands and flags below (plus `--help`); unknown flags print usage and exit non-zero.

```bash
cargo run -p zyquor-cli -- <command> [flags]
```

| Command | Purpose |
| --- | --- |
| `start` | Launch/reuse the dedicated Chrome over CDP, then run the API and worker in-process and start the Vite dev server from one command. Ctrl-C stops it. |
| `api` | Run the axum API only. |
| `worker` | Run the background worker only. Requires `ZYQUOR_RUN_WORKER=1`; takes the worker lock. |
| `web` | Run the Vite dev server only. |
| `open-profile [--manual]` | Ensure the CDP Chrome is running, or with `--manual` open a normal Chrome window at the X login page and wait for Enter. |
| `check-login` | Check the dedicated profile's X session. Prints JSON and exits 0 only when logged in. |
| `post-loop [--once] [--dry] [--force]` | Original-post lane: rotating topics, draft, screen, approve, post through the gated API path. |
| `reply-loop [--once] [--dry]` | Reply lane: discover from the home feed then X search, draft best-of-N, screen, approve, post. Does not touch mentions. |
| `overseer [--once] [--dry] [--interval-ms <ms>]` | Audit queued drafts/jobs, and posted history when the post flag is on, for slop and delete offending items through the API. Interval defaults to 300000 ms. |
| `backfill-timeline [--dry-run]` | Fetch enabled accounts' timelines over CDP, record measurements and style examples. Appends `data/backfill.jsonl`. |
| `poll-mentions [--dry]` | Thin API client for mention scanning; `--dry` (or `DRY_RUN=1`) lists mentions without drafting. Never posts. |
| `seed-account [handle] [display name...]` | Idempotently create the business style profile and account. Defaults to handle `business`. |
| `lessons [--dry]` | Propose standing corrections from measured posts and append them to the feedback notebook. Read-only on the DB. |
| `outreach <find\|queue\|review\|list\|mark-sent\|skip\|verify>` | Find live Reddit/HN threads, rank them, and review answers in a separate local queue. No posting path. See [outreach.md](outreach.md). |
| `tweet-eval` | Run the fixed five-case generation evaluation with heuristic scoring and a `command-code` judge. Exits non-zero unless every case passes. |
| `smoke-generation` | Live provider probe: generate candidates for one idea and print JSON. |

`post-loop`, `reply-loop`, and `tweet-eval` call live providers; the loops also start posting lanes. Run them only on an explicit human ask.

## Local Runbook

One command brings up Chrome, the API, the worker, and the web UI:

```bash
cargo run -p zyquor-cli -- start
```

Open <http://127.0.0.1:5173>. The dev runner targets `http://127.0.0.1:3001` by default (`ZYQUOR_API_PORT_OVERRIDE` / `ZYQUOR_API_URL_OVERRIDE`). Its in-process worker follows `ZYQUOR_API_URL`, so set it to the same base URL.

To run the pieces separately:

```bash
cargo run -p zyquor-cli -- api
ZYQUOR_RUN_WORKER=1 ZYQUOR_API_URL=http://127.0.0.1:3001 cargo run -p zyquor-cli -- worker
ZYQUOR_API_URL=http://127.0.0.1:3001 pnpm --dir apps/web dev
```

The standalone API binary (`cargo run -p zyquor-api`) listens on `127.0.0.1:3000` and retries on 3001 when 3000 is busy and `ZYQUOR_API_PORT` is unset. Pin it with `ZYQUOR_API_PORT=3001`. The Vite dev server proxies `/api` to `ZYQUOR_API_URL`, defaulting to `http://127.0.0.1:3000`.

Runtime files:

```text
<dataRoot>/
  app.sqlite            # the only persistence
  data/artifacts/       # browser screenshots/traces
  profiles/<handle>/    # dedicated Chrome profile per account
```

`<dataRoot>` is the current directory unless `ZYQUOR_DATA_ROOT` is set. The desktop app defaults it to the Tauri app data directory.

## Desktop (Tauri v2)

Build the renderer first, then run from the repo root on native Windows:

```bash
pnpm --dir apps/web build
cargo tauri dev
cargo tauri build
```

The desktop shell runs the API and worker in-process on an ephemeral port, adds the tray/window, and injects its control plane after startup. `tauri.conf.json` lives at `apps/desktop/tauri.conf.json` and consumes `../web/dist`.

Headless boot check on any operating system:

```bash
cargo run -p zyquor-desktop -- --headless-smoke
```

It starts the API and worker without a window, probes `/accounts`, `/worker/status`, `/system/status`, and `/system/logs`, shuts down, and exits 0 on success. Its data root is `${ZYQUOR_DATA_ROOT:-<temp>/zyquor-headless}`.

Desktop details:

- Data root: Tauri app data directory, or `ZYQUOR_DATA_ROOT`.
- Settings: `settings.json` in the data root.
- API keys are currently stored as plaintext in `settings.json`; there is no OS secret-store encryption yet. Legacy `enc:v1:` values are stripped on load and still work.
- Logs: `<dataRoot>/logs/main.log`; rotates to `main.log.1` at 5 MB, checked on write and at startup.
- The `headless` setting maps to `ZYQUOR_BROWSER_HEADLESS`; `cdpPort` maps to `ZYQUOR_BROWSER_CDP_URL`.
- Do not run the desktop app inside WSL. Use a native Windows checkout and install the generation CLI there too.

## Browser and Profiles

Every account gets its own Chrome profile at `profiles/<handle>` and its own remote-debugging port. Jobs for different accounts run concurrently; each account still runs at most one browser job at a time.

Log in to a dedicated profile:

```bash
# Default profile (profiles/personal-main); for an account profile:
ZYQUOR_X_PROFILE_DIR=profiles/<handle> cargo run -p zyquor-cli -- open-profile --manual
# Log in to X in the window, then fully close that browser.
ZYQUOR_X_PROFILE_DIR=profiles/<handle> cargo run -p zyquor-cli -- check-login
```

`open-profile` without `--manual` ensures the CDP Chrome is running and leaves it open. `ZYQUOR_BROWSER_HEADLESS=1` launches it with `--headless=new`.

CDP ports are derived by `per_profile_cdp_url` in `crates/zyquor-core/src/paths.rs`; do not reimplement the mapping. `profiles/personal-main` stays on the base port (default 9222), `willainotice` uses base+1, and other profiles use a stable hash offset. `ZYQUOR_BROWSER_CDP_BASE_PROFILES` pins named profiles to the base port.

Other browser facts:

- System Chrome only. Set `ZYQUOR_CHROME_PATH` (or `CHROME_BIN`) when Chrome is not on the default path; `ZYQUOR_BROWSER_CHANNEL=chrome` is the supported channel.
- `ZYQUOR_BROWSER_CDP_URL` changes the base CDP endpoint.
- `ZYQUOR_ENABLE_BROWSER_PREPARE=1` enables real prepare; `ZYQUOR_ENABLE_BROWSER_POST=1` enables the final Post click. They are separate gates.
- Debugging headless means screenshots under `<dataRoot>/data/artifacts`, not looking at a window.

## Smoke Checks

There are no pnpm smoke scripts anymore. The real smoke entry points are:

```bash
cargo run -p zyquor-desktop -- --headless-smoke   # API + worker boot, no window
cargo run -p zyquor-cli -- check-login             # dedicated-profile X session
cargo run -p zyquor-cli -- smoke-generation        # live provider generation
cargo run -p zyquor-cli -- tweet-eval              # generation quality eval
cargo test --workspace                             # unit and API-workflow tests
```

`check-login` needs Chrome CDP and an actual logged-in profile. `smoke-generation`, `tweet-eval`, and the loops need a configured provider; `tweet-eval` also shells out to `command-code` for judging, which can fail independently of the provider under test. There is no end-to-end suite.

## Environment Flags

Generation config resolves in this order: saved `data/generation.json` > process environment > desktop settings snapshot. The saved file wins over both. Every Rust entry point calls `zyquor_core::dotenv::load()` first, so a `.env` in the repo root (or any parent of the working directory) is loaded without overriding variables you already exported; `cp .env.example .env` works as the README says. `PATCH /generation` writes `data/generation.json`; restart the process to apply it.

| Variable | Effect |
| --- | --- |
| `ZYQUOR_DATA_ROOT` | Runtime data root; falls back to `ZYQUOR_WORKSPACE_ROOT`, then the current directory. |
| `ZYQUOR_API_PORT` | Standalone API port. Default 3000, with a one-shot 3001 retry when the port is busy and this is unset. |
| `ZYQUOR_API_URL` | API base used by the CLI loops, worker, and Vite proxy. |
| `ZYQUOR_API_PORT_OVERRIDE`, `ZYQUOR_API_URL_OVERRIDE` | API target used by `zyquor start`/`api`/`web`; default 3001. |
| `ZYQUOR_RUN_WORKER` | Must be `1` for `zyquor worker`. `start` runs the worker in-process. |
| `ZYQUOR_WORKER_POLL_MS` | Worker poll interval; default 5000 ms. |
| `ZYQUOR_WORKER_INGEST_INTERVAL_MS` | Ingest cadence; default 60000 ms. |
| `ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST` | `0` disables seeding the default news ingest config. |
| `ZYQUOR_LLM_PROVIDER` | `opencode` (the desktop default), `command-code`, `gemini`, `ollama`, or `auto`. An unset value also resolves as `auto`: Gemini when `ZYQUOR_GEMINI_API_KEY` is set, otherwise Ollama. |
| `ZYQUOR_OPENCODE_MODEL`, `ZYQUOR_OPENCODE_VARIANT`, `ZYQUOR_OPENCODE_PATH` | Opencode model (default `opencode/glm-5.3-flash-free`), variant (`low`/`high`/`max`, default `high`), and CLI path. |
| `ZYQUOR_COMMAND_CODE_MODEL`, `ZYQUOR_COMMAND_CODE_PATH` | Command Code model (default `gpt-5.6-luna`) and CLI path. |
| `ZYQUOR_GEMINI_API_KEY`, `ZYQUOR_GEMINI_MODEL`, `ZYQUOR_GEMINI_BASE_URL` | Gemini credentials and model (default `gemini-3.6-flash`). |
| `ZYQUOR_OLLAMA_MODEL`, `ZYQUOR_OLLAMA_BASE_URL` | Ollama model (default `gemma4:e4b`) and endpoint (default `http://127.0.0.1:11434`). |
| `ZYQUOR_REVISION_PASS` | `1` adds the cut-only second revision pass for opencode; off by default. |
| `ZYQUOR_QUALITY_MIN`, `ZYQUOR_REPLY_QUALITY_MIN` | Deterministic quality floors; default 7 for posts, 5 for replies. |
| `ZYQUOR_ENABLE_BROWSER_PREPARE`, `ZYQUOR_ENABLE_BROWSER_POST` | Enable the browser prepare and post lanes (`1`). The standalone API, worker, and CLI treat anything other than `1` as off. |
| `ZYQUOR_BROWSER_CHANNEL` | `chrome`; system Chrome is the only browser engine (no bundled Chromium). |
| `ZYQUOR_BROWSER_HEADLESS` | `1` runs Chrome with `--headless=new`. |
| `ZYQUOR_BROWSER_CDP_URL` | Base CDP endpoint; default `http://127.0.0.1:9222`. |
| `ZYQUOR_BROWSER_CDP_BASE_PROFILES` | Comma-separated profiles pinned to the base port; default `personal-main`. |
| `ZYQUOR_CHROME_PATH` / `CHROME_BIN` | Chrome executable override. |
| `ZYQUOR_X_PROFILE_DIR` | Profile used by `open-profile` and `check-login`; default `profiles/personal-main`. |
| `ZYQUOR_BROWSER_ACTION_DELAY_MS`, `ZYQUOR_BROWSER_TYPING_DELAY_MS` | Pacing for browser actions and typed input. |
| `ZYQUOR_MENTIONS_AUTO_DRAFT`, `ZYQUOR_MENTIONS_AUTO_APPROVE`, `ZYQUOR_MENTIONS_ACCOUNTS`, `ZYQUOR_MENTIONS_INTERVAL_MS` | Worker mention lanes. Auto-approve takes precedence; interval defaults to 15 minutes. |
| `ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP` | Per-account daily approval cap; default 3, 0 disables, clamped 0..50. |
| `ZYQUOR_PRODUCTHUNT_API_TOKEN` | Optional Product Hunt source credential. |
| `ZYQUOR_LLM_DEBUG` | `1` writes the exact prompt and raw model output to artifacts. |

Loop-specific settings such as `ZYQUOR_POST_LOOP_*` and `ZYQUOR_REPLY_LOOP_*` are read by the loops themselves; the env reads live in `apps/cli/src/post_loop.rs` and `apps/cli/src/reply_loop.rs`.

## HTTP API

The API binds `127.0.0.1`. These are the routes registered by `apps/api/src/routes/*.rs`:

- **Drafts:** `POST /drafts`, `POST /drafts/research`, `POST /drafts/:id/generate`, `GET /drafts/pending`, `GET /drafts/quality-gate-failures`, `GET|DELETE /drafts/:id`, `POST /drafts/:id/evaluate`, `POST /drafts/:id/select`, `POST /drafts/:id/approve`.
- **Jobs:** `GET|DELETE /jobs`, `DELETE /jobs/cleanup`, `POST /jobs/post-next`, `POST /jobs/post-ready`, `POST /jobs/recover-stale`, `GET /jobs/:id/attempts`, `POST /jobs/:id/prepare`, `POST /jobs/:id/post`, `POST /jobs/:id/retry`, `PATCH|DELETE /jobs/:id`.
- **Batch:** `POST /draft-batches`.
- **Replies:** `GET /replies/feed`, `POST /replies/from-url`, `GET /replies/mentions`, `POST /replies/mentions/draft`, `POST /replies/mentions/scan-and-draft`, `POST /replies/mentions/scan-and-auto-approve`, `GET /replies/drafts`.
- **Source packets:** `GET|POST|DELETE /source-packets`, `DELETE /source-packets/:id`, `POST|GET|DELETE /source-packets/:id/draft`, `POST /source-packets/:id/regenerate`, `POST /source-packets/:id/feedback`.
- **Ingest:** `GET /ingest-runs`, `POST /ingest-runs/recover-stale`, `GET|POST /ingest-configs`, `GET /ingest-sources`, `POST /ingest-configs/default-news`, `PATCH|DELETE /ingest-configs/:id`, `POST /ingest-run`, `POST /ingest-run/async`.
- **Knowledge:** `GET|POST /knowledge`, `PATCH|DELETE /knowledge/:id`.
- **Feedback:** `GET|POST /system-feedback`, `DELETE /system-feedback/:id`.
- **Style profiles:** `GET|PATCH /style-profiles/:id`.
- **Generation:** `GET|PATCH /generation`.
- **Browser:** `POST /browser/activate`, `GET /browser/active`, `GET /browser/x-session`, `POST /browser/launch-chrome`.
- **Accounts:** `GET|POST /accounts`, `PATCH|DELETE /accounts/:id`.
- **History/performance:** `GET /history`, `GET /history/analysis`, `POST /history/:id/delete`, `GET /performance`, `POST /performance/refresh`.
- **Settings/onboarding:** `GET|PATCH /settings`, `GET /onboarding/status`.
- **System:** `GET /system/status`, `POST /system/posting`, `POST /system/ingest/cancel`.
- **Worker:** `GET /health`, `GET /worker/status`, `POST /worker/heartbeat`.

Desktop-only system routes: `GET /system/logs`, `POST /system/worker/pause`, `POST /system/chrome/close`, `POST /system/stop-all`, `POST /system/quit`, `POST /system/restart`. They are registered but return 404 unless the Tauri shell has injected its control plane; the standalone API has no desktop controls.

## Troubleshooting

**Port already in use.** The standalone API retries 3001 only when `ZYQUOR_API_PORT` is unset. Set `ZYQUOR_API_PORT=3001` explicitly, and point the worker/web at it with `ZYQUOR_API_URL=http://127.0.0.1:3001`.

**Chrome CDP did not become ready.** Run `cargo run -p zyquor-cli -- open-profile` and keep that Chrome window open. Check `ZYQUOR_BROWSER_CDP_URL` and the per-profile port; `check-login` reports the CDP error when it cannot connect.

**X did not render does not mean logout.** If the login check says `X did not render the authenticated shell ... even though the session is valid`, the credentials check already returned a handle: the session is fine and the page client stopped painting. Relaunch the dedicated profile and retry. If the same profile still will not render, move to a fresh profile and log in once. Never clear x.com cookies or site data for this error; that destroys a valid session.

**Headless bugs.** Take screenshots from `<dataRoot>/data/artifacts`. Keep a headed launch path for comparison when a page fails only in headless mode.

**Composer left holding text.** A failed post can leave unsent text in the composer, which triggers a `beforeunload` dialog on the next navigation. The Rust session dismisses dialogs, but clear the composer (`Ctrl+A`, `Backspace`) before the next attempt. Failed external posts are never auto-retried.

**Worker will not start.** `zyquor worker` requires `ZYQUOR_RUN_WORKER=1` and a free worker lock (`data/zyquor-worker.lock` by default; override with `ZYQUOR_WORKER_LOCK_PATH`). A live PID in the lock file blocks a second worker.

**Generation fails.** Check `GET /generation` and run `cargo run -p zyquor-cli -- smoke-generation`. A free `opencode` usage cap (`Free usage limit reached`) is an account quota, not a code fault; paid models need funds. The opencode CLI can exit 1 with `ECONNRESET` after writing valid candidates, in which case the provider still accepts stdout.

**Desktop app in WSL.** It will not run correctly. Use native Windows, and install/authenticate the generation CLI there as well.

**Data looks missing.** Persistence is SQLite only (`app.sqlite`); there is no JSON fallback. Check the effective `ZYQUOR_DATA_ROOT` and that the process is using the database you expect.
