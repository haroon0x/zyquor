# Zyquor

Local-first X posting assistant for drafting, review, and dedicated-profile browser preparation.

V1 is intentionally narrow:

```text
idea -> LLM draft candidates -> review/edit -> approved job -> dedicated Chrome profile -> X compose insertion
```

## Repository Layout

- `apps/web`: Vite React local UI.
- `apps/api`: Fastify local API.
- `apps/worker`: background worker entrypoint.
- `packages/core`: shared domain types, Zod schemas, lifecycle transitions.
- `packages/accounts`: account config helpers.
- `packages/adapters`: source ingestion and crawl service adapters.
- `packages/generation`: OpenRouter, Ollama, and Gemini draft generation providers.
- `packages/storage`: SQLite/Drizzle persistence surface.
- `packages/browser`: Playwright prepare/post flow.
- `packages/voice`: future voice input package.

## Development

Use pnpm workspaces.

```bash
pnpm install
pnpm bootstrap
pnpm smoke
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

Default provider selection is `auto`: OpenRouter first when configured, then Ollama.

Create a local `.env` before running generation:

```bash
cp .env.example .env
```

Use OpenRouter for best tweet quality:

```bash
cp .env.example .env
# edit .env:
# ZYQUOR_LLM_PROVIDER=openrouter
# ZYQUOR_OPENROUTER_API_KEY=...
# Allowed free OpenRouter models:
# nvidia/nemotron-3-super-120b-a12b:free
# minimax/minimax-m2.5:free
# tencent/hy3-preview:free
# ZYQUOR_OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
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
```

Run the tweet quality harness against the active provider:

```bash
pnpm harness:tweets
```

## Safety Defaults

- Do not use everyday Chrome profiles.
- Browser automation uses dedicated persistent profile directories under `profiles/`.
- Account settings enforce profile paths under `profiles/`.
- `profiles/`, SQLite files, and browser artifacts are ignored by Git.
- V1 browser mode should start with `prepare_only`.
- Full post submission should stay disabled until compose insertion is reliable.

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
