# Zyquor

Local-first X posting assistant for drafting, source ingest, review, scheduling, and dedicated-profile browser posting.

Current core flow:

```text
topic/rough post -> fresh source search -> grounded draft -> review/edit or autopost approval -> job -> dedicated Chrome profile -> X prepare/post -> history
```

## Repository Layout

- `apps/web`: Vite React local UI.
- `apps/api`: Fastify local API.
- `apps/worker`: background worker entrypoint.
- `packages/core`: shared domain types, Zod schemas, lifecycle transitions.
- `packages/accounts`: account config helpers.
- `packages/adapters`: source ingestion and crawl service adapters.
- `packages/generation`: Command Code, OpenRouter, Ollama, and Gemini draft generation providers.
- `packages/storage`: SQLite/Drizzle persistence surface.
- `packages/browser`: Playwright prepare/post flow.

## Development

Use pnpm workspaces.

```bash
pnpm install
pnpm bootstrap
pnpm smoke
pnpm smoke:adapters
./zyquor
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm dev:crawl4ai
pnpm check
pnpm test
pnpm build
```

Run the local API and web UI in separate terminals:

```bash
pnpm dev:api
pnpm dev:web
```

The API reads `.env` from the repo root. The web UI uses `ZYQUOR_API_URL`, defaulting to `http://127.0.0.1:3000`.

`pnpm dev:crawl4ai` starts the optional local Crawl4AI REST service from `services/crawl4ai`; source adapters use it through `CRAWL4AI_API_URL`, defaulting to `http://127.0.0.1:11235/crawl`.

## One-command start

From the repo root:

```bash
./zyquor
```

This starts or reuses:

- Chrome CDP with `profiles/personal-main`.
- API at `http://127.0.0.1:3001`.
- Web UI at `http://127.0.0.1:5173/`.
- Worker for due approved/scheduled jobs.
- Async source ingest and autopost queue polling.

Keep the terminal open while using Zyquor. To check runtime from another terminal:

```bash
./zyquor check
```

To explicitly click Post for an approved/prepared job:

```bash
./zyquor post <jobId>
```

## Posting Modes

- `single`: generate candidates from one idea, then review/edit/approve.
- `batch`: one idea per line, create multiple jobs with optional schedule spacing.
- `yolo`: one idea in, one candidate generated, approved as `autopost`, then posted immediately when no schedule is set.
- `prepare_only`: insert text into X compose and stop.
- `scheduled`: wait until `scheduledFor`, then worker prepares the job.
- `autopost`: wait until due, then worker calls the explicit post endpoint.
- `review_required`: keep job manual.

If you want bare `zyquor` instead of `./zyquor`, install/link the repo command once in your shell environment.

## Draft Generation

Default provider selection is resolved from saved generation config and environment. Codex with Luna on high reasoning is the default; Command Code, OpenRouter, Gemini, and Ollama providers remain available.

Install and authenticate Command Code once before starting Zyquor:

```bash
npm install -g command-code@latest
command-code login
command-code status
```

Zyquor runs Command Code in non-interactive, read-only plan mode with `deepseek/deepseek-v4-pro`. Codex uses `codex exec` with Luna and high reasoning. Candidates that drop or change supplied URLs or introduce unsupported numbers are rejected and regenerated once. On native Windows, install the selected CLI natively so the Electron app can launch it; a copy installed only inside WSL is not visible to a native Windows app. If it is not on the desktop app's `PATH`, set the full executable path in Settings.

Codex CLI is also supported. Authenticate it once, then select it in the Generation panel or set it in `.env`:

```bash
codex login
ZYQUOR_LLM_PROVIDER=codex ZYQUOR_CODEX_MODEL=luna ZYQUOR_CODEX_PATH=codex pnpm dev:api
```

The Zyquor Codex provider uses `luna` with high reasoning by default. The current Codex CLI resolves that alias to `gpt-5.6-luna`. Set `ZYQUOR_CODEX_MODEL` to a different Codex model when needed.

Create a local `.env` before running generation:

```bash
cp .env.example .env
```

Use a different provider if Command Code is unavailable:

```bash
cp .env.example .env
# edit .env:
# ZYQUOR_LLM_PROVIDER=openrouter
# ZYQUOR_OPENROUTER_API_KEY=...
# Full free-model allowlist is in OPENROUTER_MODELS in packages/generation/src/config.ts.
pnpm dev:api
```

Use local Ollama fallback:

```bash
ollama serve
ollama pull llama3.1
ZYQUOR_LLM_PROVIDER=ollama ZYQUOR_OLLAMA_MODEL=llama3.1 pnpm dev:api
```

Fast Ollama smoke with a tiny model:

```bash
ollama serve
ollama pull tinyllama
ZYQUOR_LLM_PROVIDER=ollama ZYQUOR_OLLAMA_MODEL=tinyllama pnpm smoke:generation
```

Check active provider:

```bash
curl http://127.0.0.1:3001/generation
```

Smoke-test selected provider:

```bash
pnpm smoke:generation
ZYQUOR_LLM_PROVIDER=openrouter ZYQUOR_OPENROUTER_API_KEY=... pnpm smoke:generation
ZYQUOR_LLM_PROVIDER=ollama pnpm smoke:generation
ZYQUOR_LLM_PROVIDER=codex pnpm smoke:generation
```

Run the tweet quality harness against the active provider:

```bash
pnpm harness:tweets
```

Run the full quality eval with the configured generator and an independent Command Code judge:

```bash
node scripts/tweet-eval.mjs
```

The eval reports the deterministic quality-floor rate even when the external judge is unavailable.

## Safety Defaults

- Do not use everyday Chrome profiles.
- Browser automation uses dedicated persistent profile directories under `profiles/`.
- Account settings enforce profile paths under `profiles/`.
- `profiles/`, SQLite files, and browser artifacts are ignored by Git.
- Keep real browser prepare/post disabled until the dedicated X profile is logged in and checked.
- Failed external post jobs are not auto-retried because a failed browser run may still have reached X.
- Post history stores source metadata for traceability.

## Browser Prepare

The API defaults to dry-run prepare. It moves an approved job to `prepared` without opening X, which keeps local UI development fast.

Real X browser prepare prerequisites:

- Install Playwright browsers once: `pnpm --filter @zyquor/browser exec playwright install chromium`.
- Use only a dedicated profile under `profiles/`; never point Zyquor at an everyday browser profile.
- Open the dedicated profile with `pnpm profile:x`, then log into X in that browser.
- If X blocks Playwright-controlled login, use `pnpm profile:x:manual`. It opens normal Chrome with the same dedicated profile and no Playwright control.
- For the most Chrome-like prepare flow, use `pnpm profile:x:cdp`, keep that Chrome window open, and set `ZYQUOR_BROWSER_CDP_URL=http://127.0.0.1:9222`.
- Check whether the dedicated profile is currently logged into X with `pnpm profile:x:check`.
- The web UI also has a `Check X` control in the account strip.
- Keep `ZYQUOR_ENABLE_BROWSER_POST=0` until prepare-only insertion is reliable.
- Default browser channel is bundled Chromium. Set `ZYQUOR_BROWSER_CHANNEL=chrome` only when Chrome is installed.
- Browser actions are intentionally slow. Tune with `ZYQUOR_BROWSER_ACTION_DELAY_MS` and `ZYQUOR_BROWSER_TYPING_DELAY_MS`.

After login, enable real browser prepare in `.env`:

```text
ZYQUOR_ENABLE_BROWSER_PREPARE=1
```

Enable the final Post click only when you are ready for Zyquor to submit public posts:

```text
ZYQUOR_ENABLE_BROWSER_POST=1
```

Enable the real Playwright prepare flow explicitly:

```bash
ZYQUOR_ENABLE_BROWSER_PREPARE=1 pnpm dev:api
```

The real prepare flow opens `https://x.com/compose/post` in the account's dedicated profile directory and inserts the approved text. It leaves the browser open for manual posting. It does not click Post.

If `ZYQUOR_BROWSER_CDP_URL` is set, start `pnpm profile:x:cdp` before preparing a job. This makes Zyquor connect to that already-open Chrome instance instead of launching a separate automated browser process.

Enable controlled post clicking separately:

```bash
ZYQUOR_ENABLE_BROWSER_PREPARE=1 ZYQUOR_ENABLE_BROWSER_POST=1 pnpm dev:api
```

The Post action can run from an approved or prepared job. Keep this off until prepare-only insertion is reliable in the dedicated profile.

For real prepare-only mode, the browser window remains open after text insertion so the user can inspect and complete the post manually.

## Local Persistence

The current repository uses `node:sqlite` with `data/app.sqlite` by default. If `node:sqlite` is unavailable, it falls back to JSON state in `data/app.json`. The SQL target schema is in `packages/storage/migrations/0001_initial.sql`.

## Automated Sources

Zyquor can seed a default news ingest config and run source ingestion from the worker:

```bash
curl -X POST http://127.0.0.1:3001/ingest-configs/default-news
curl -X POST http://127.0.0.1:3001/ingest-run
```

Live adapter smoke:

```bash
pnpm smoke:adapters
```

Required sources should return data. Product Hunt is optional unless `ZYQUOR_PRODUCTHUNT_API_TOKEN` is set.

Ingest filters reject undated or older-than-48-hour items before packet creation, then prevent repeats, thin context, and blocked payment links. Host caps default to `ZYQUOR_MAX_SAME_HOST_POSTS_PER_DAY=100` and `ZYQUOR_MAX_GITHUB_POSTS_PER_DAY=100`.
The worker auto-seeds the default news source unless `ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST=0` is set.

Useful diagnostics:

```bash
curl http://127.0.0.1:3001/worker/status
curl http://127.0.0.1:3001/ingest-sources
./zyquor analyze --hours 24
```

## Desktop app (Windows)

Zyquor ships as a system-tray Electron desktop app for Windows. The API, worker, and web UI run in-process instead of separate terminals. Starting the app also starts or reconnects its dedicated posting Chrome profile. The window can be closed to tray, keeping the worker alive in the background.

```bash
pnpm dev:desktop        # build and launch
pnpm smoke:desktop      # headless logic smoke (no GUI required)
pnpm dist:desktop:dir   # produce unpacked Windows app (no Wine required)
pnpm dist:desktop       # produce NSIS installer (CI: dist-desktop-win job)
```

Run the generated NSIS installer from `apps/desktop/release`. The installer creates `Zyquor` shortcuts on the Windows desktop and Start menu using the packaged app icon. Launch Zyquor from that desktop shortcut, sign in to X once in the dedicated Chrome window, and leave final browser posting disabled until prepare-only insertion has been checked.

On Linux or WSL, building the NSIS installer requires Wine. Use `pnpm dist:desktop:dir` for an unpacked Windows build at `apps/desktop/release/win-unpacked`, copy that folder to a local Windows path before launching `Zyquor.exe`, or run the `dist-desktop-win` GitHub Actions job for the installer. Electron can crash when launched directly from the WSL UNC path.

- **Data root**: `%APPDATA%/Zyquor` (overridable via `ZYQUOR_DATA_ROOT`).
- **Settings**: `settings.json` in the data root — edit from the Desktop Settings panel in the UI.
- **Posting Chrome**: starts with the desktop app and remains available from the tray menu; it uses a dedicated Chrome profile with CDP on port 9222.
- **App icon**: generated from `apps/desktop/build/icon.svg` and used by the window, tray, installer, and shortcuts.
- **Code signing**: signed release builds use Azure Artifact Signing; unsigned local installers still trigger normal Windows trust warnings.
