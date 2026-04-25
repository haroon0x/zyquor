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
- `packages/generation`: mock, Ollama, and Gemini draft generation providers.
- `packages/storage`: SQLite/Drizzle persistence surface.
- `packages/browser`: Playwright prepare/post flow.
- `packages/voice`: future voice input package.

## Development

Use pnpm workspaces.

```bash
pnpm install
pnpm bootstrap
pnpm smoke
pnpm dev:api
pnpm dev:web
pnpm dev:worker
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

## Draft Generation

Default provider is `mock`, so dev and tests work offline.

Create a local `.env` before using non-mock providers:

```bash
cp .env.example .env
```

Use local Ollama:

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

Use Gemini:

```bash
cp .env.example .env
# edit .env:
# ZYQUOR_LLM_PROVIDER=gemini
# ZYQUOR_GEMINI_API_KEY=...
# ZYQUOR_GEMINI_MODEL=gemini-2.5-flash
pnpm dev:api
```

Gemini smoke using `.env`:

```bash
# .env must include:
# ZYQUOR_LLM_PROVIDER=gemini
# ZYQUOR_GEMINI_API_KEY=your_key_here
pnpm smoke:generation
```

Check active provider:

```bash
curl http://127.0.0.1:3000/generation
```

Smoke-test selected provider:

```bash
pnpm smoke:generation
ZYQUOR_LLM_PROVIDER=ollama pnpm smoke:generation
ZYQUOR_LLM_PROVIDER=gemini ZYQUOR_GEMINI_API_KEY=... pnpm smoke:generation
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

Enable controlled post clicking separately:

```bash
ZYQUOR_ENABLE_BROWSER_PREPARE=1 ZYQUOR_ENABLE_BROWSER_POST=1 pnpm dev:api
```

The Post action can run from an approved or prepared job. Keep this off until prepare-only insertion is reliable in the dedicated profile.

For real prepare-only mode, the browser window remains open after text insertion so the user can inspect and complete the post manually.

## Local Persistence

The current repository uses `node:sqlite` with `data/app.sqlite` by default. If `node:sqlite` is unavailable, it falls back to JSON state in `data/app.json`. The SQL target schema is in `packages/storage/migrations/0001_initial.sql`.
