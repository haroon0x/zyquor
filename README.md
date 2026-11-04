# Zyquor

> **Not in active development — Herald is the successor.**
> This repository is no longer being worked on. New X (Twitter) agent
> capabilities — reading mentions and DMs, drafting, posting, scheduling-grade
> autonomy controls, and the same approval-gated safety model — are being built
> in [herald](https://github.com/haroon0x/herald), which absorbs this project's
> role. This tree stays available as a reference and for the posting pipeline
> you already use; expect no fixes, releases, or support.

**Local-first X posting assistant.** Zyquor turns an idea or a fresh source into a grounded draft, puts it in a review queue, and posts it through a dedicated Chrome profile you control. Everything runs on your machine: SQLite storage, no hosted backend, no cloud account.

[![CI](https://github.com/haroon0x/zyquor/actions/workflows/ci.yml/badge.svg)](https://github.com/haroon0x/zyquor/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

> **Status: v0.1.0.** The TypeScript tree is the running product. The Rust migration is in progress; see [docs/rust-migration.md](docs/rust-migration.md) and [ROADMAP.md](ROADMAP.md) for exactly what is and is not ported.

## Why it exists

Posting well is the hard part, not scheduling. Most "AI social" tools write generic filler, decide what to post for you, and automate engagement. Zyquor does the opposite:

- An LLM writes **candidate text only**. It never browses, schedules, ranks, or decides to post.
- Every draft lands in a **review queue**. Nothing publishes unless you, or an explicitly enabled gate, approves it.
- Posting uses **your own dedicated Chrome profile** and the normal X web app, not private APIs or engagement loops.
- Quality is enforced by **deterministic rules** (`scoreTweetQuality`), so slop and source recaps are rejected by code, not by another LLM's opinion.

## What you can do

| Lane | What happens |
| --- | --- |
| **Single** | One idea in, a few candidates out, pick or edit one, approve it. |
| **Batch** | One idea per line, many drafts at once, optional schedule spacing. |
| **Yolo** | One idea, one candidate, approved as `autopost`. Still gated by flags, limits, and quiet hours. |
| **Sources** | Adapters ingest fresh items into source packets; a packet becomes one grounded draft. |
| **Replies** | Scan mentions or paste a post URL, draft a reply grounded in the target, review it. |

Plus: a review queue, scheduled jobs, post history with source attribution, a worker that runs due jobs, style profiles, standing feedback injected into every prompt, and a tray-resident desktop app that runs the API, worker, and UI in one process.

## How it works

```text
idea / source item
      │
      ▼
generation provider (opencode | command-code | gemini | ollama)
      │  candidates only
      ▼
review queue ──edit/select/approve──► job (prepare_only | scheduled | autopost | review_required)
      │
      ▼
worker picks due jobs ──► dedicated Chrome profile (CDP) ──► X compose ──► explicit Post click
      │
      ▼
post history + attempt logs + artifacts
```

The LLM boundary is enforced in code: generation packages only return text. Scheduling, ranking, browser automation, and the post decision live elsewhere and are independently gated.

## Quick start

Requirements: **Node 24**, **pnpm 10**, **Chrome** (or the bundled Playwright Chromium), and an X account you are willing to post from.

```bash
git clone https://github.com/haroon0x/zyquor.git
cd zyquor
pnpm install
cp .env.example .env
pnpm bootstrap         # creates the data root and the first profile directory
pnpm dev:api           # API on http://127.0.0.1:3001 (see ports below)
pnpm dev:web           # UI on http://127.0.0.1:5173
```

Then open <http://127.0.0.1:5173>.

Port 3000 is often taken by other local apps, so the API falls back to **3001** when `ZYQUOR_API_PORT` is unset. When you use 3001, start the web UI with a matching proxy target:

```bash
ZYQUOR_API_URL=http://127.0.0.1:3001 pnpm --filter @zyquor/web dev
```

Or start everything with one command (Chrome, API, UI, worker):

```bash
./zyquor
./zyquor check
./zyquor post <jobId>
```

### Generation provider

The default and only preconfigured provider is **opencode**, running `opencode/glm-5.3-flash-free` with high reasoning. On rate-limit/unavailable/funds errors, failover walks the approved pool: `opencode-go/glm-5.3-flash`, then `opencode/deepseek-v4.1-flash`:

```bash
npm install -g opencode-ai   # or any install that puts `opencode` on PATH
opencode auth login          # follow the CLI prompts
```

Alternatives are supported through the same interface: `command-code` (CLI), `gemini` (HTTP API key), and `ollama` (local HTTP). Set `ZYQUOR_LLM_PROVIDER` and the matching model variable in `.env`; check the resolved provider at `GET /generation`. See [.env.example](.env.example) for every variable.

No provider is bundled and no mock provider exists in production paths: tests inject fake providers.

### Dedicated X profile

Posting only ever uses a profile under `profiles/`:

```bash
pnpm profile:x:manual   # opens normal Chrome with the dedicated profile, no automation
# log in to X once in that window, then close it
pnpm profile:x:check    # verifies the session
```

`pnpm profile:x:cdp` launches the same profile with remote debugging, which is what the worker connects to. `ZYQUOR_BROWSER_HEADLESS=1` runs it without a visible window.

**Never point Zyquor at your everyday Chrome profile.** Account config only accepts paths under `profiles/`, and that check is deliberate.

### Posting is off by default

```text
ZYQUOR_ENABLE_BROWSER_PREPARE=0   # real browser prepare disabled
ZYQUOR_ENABLE_BROWSER_POST=0      # final Post click disabled
```

Prepare inserts text into X compose and stops. Post clicks the button. Enable them one at a time, after you have watched prepare work on your own profile.

## Safety rails

These are product rules, not suggestions, and pull requests that weaken them are not merged:

- Dedicated profiles under `profiles/` only; never the user's everyday Chrome profile.
- No stealth, anti-detection, proxy rotation, CAPTCHA bypass, or fingerprint spoofing.
- No automated follows, likes, reposts, DMs, or engagement loops.
- The LLM writes candidate text only; it never browses, schedules, ranks, or posts.
- The final post action is explicit, gated by env flags, logged, and recorded with attempt artifacts.
- Failed external post jobs are **not auto-retried**: a failed browser action may still have reached X.
- Browser automation stays isolated in `packages/browser` (TypeScript) and `crates/zyquor-browser` (Rust).

Read [SECURITY.md](SECURITY.md) before filing anything that involves cookies, tokens, or profile data.

## Repository layout

```text
apps/
  api/        Fastify API (drafts, jobs, replies, sources, system control)
  web/        Vite + React UI
  worker/     background loop for due jobs and ingest
  desktop/    Electron tray app (Windows), runs API + worker in-process
packages/
  core/       domain types, Zod schemas, lifecycle transitions, spacing
  accounts/   account config and profile safety
  storage/    SQLite repositories (node:sqlite)
  adapters/   source adapters, aggregation, health, optional Crawl4AI
  automation/ ingest selection, source packets, source-post quality gate
  generation/ providers, prompts, quality scoring, parsing
  browser/    Playwright/CDP prepare, post, and verification
crates/
  zyquor-core, zyquor-accounts, zyquor-storage, zyquor-generation
docs/         architecture, development, migration plan, setup guides
scripts/      operational CLIs (loops, parity harnesses, smoke tests)
skills/       portable agent skill for driving the HTTP API
```

## Rust migration

Zyquor is moving to one Cargo workspace: `crates/zyquor-{core,accounts,storage,adapters,generation,automation,browser}` plus `apps/{api,worker,desktop,web}`. The TypeScript tree stays runnable until each Rust crate passes a parity harness that compares golden fixtures against the TypeScript output. See [docs/rust-migration.md](docs/rust-migration.md) for the milestone plan, parity strategy, and deliberate removals.

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Ported so far: domain types and lifecycle, account/profile rules, the full SQLite repository surface (verified by reading databases written by the TypeScript implementation), generation config, quality scoring, prompt assembly, and candidate parsing. Providers, refine orchestration, browser, API, worker, desktop, and scripts are still TypeScript.

## Development

```bash
pnpm build       # build every package
pnpm check       # build + typecheck
pnpm test        # vitest across the workspace
pnpm smoke       # end-to-end smoke against the API
pnpm smoke:http  # HTTP route smoke
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm dev:desktop # Electron app (Windows-native; do not launch it from WSL)
```

Detailed notes live in [docs/development.md](docs/development.md) and [docs/architecture.md](docs/architecture.md). Contribution rules and the safety checklist are in [CONTRIBUTING.md](CONTRIBUTING.md).

### Quality gate

Draft candidates are scored by `scoreTweetQuality` (deterministic) and must clear `ZYQUOR_QUALITY_MIN` (default 7) to autopost. Agent-approved drafts pass the server-side screen with `screened: true`, which rejects unclean text, recaps, demand-style reply openers, and sub-floor scores. Measure prompt and pipeline changes with:

```bash
pnpm harness:tweets
node scripts/tweet-eval.mjs
```

## Desktop app (Windows)

```bash
pnpm dev:desktop        # build and launch
pnpm smoke:desktop      # headless logic smoke, no GUI
pnpm dist:desktop:dir   # unpacked Windows build
pnpm dist:desktop       # NSIS installer
```

The desktop app runs the API, worker, and UI in one process, keeps the worker alive in the tray, and starts or reconnects the dedicated posting Chrome profile. Data lives in `%APPDATA%/Zyquor` (override with `ZYQUOR_DATA_ROOT`). Settings are edited in the app and stored as `settings.json`. Building the NSIS installer on Linux or WSL requires Wine; the `dist-desktop-win` CI job builds it on Windows.

## License

Copyright (C) 2026 haroon0x and contributors.

Zyquor is free software under the **GNU Affero General Public License v3.0 only** ([AGPL-3.0-only](LICENSE)). If you run a modified version of Zyquor as a network service, you must offer its corresponding source to that service's users. See [LICENSE](LICENSE) for the full terms.

Third-party dependencies keep their own licenses; see `pnpm-lock.yaml` and `Cargo.lock` for exact versions.
