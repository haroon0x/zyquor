# Development Notes

This repo should stay easy to change as the product grows. Favor explicit contracts over implicit behavior.

## Current Build Order

1. Keep `@zyquor/core` stable first.
2. Add storage around core schemas and state transitions.
3. Wire API/UI to storage.
4. Add browser prepare flow after approved jobs exist.

## Maintainability Rules

- Keep cross-package imports pointed at public package exports.
- Add tests for state transitions before expanding lifecycle logic.
- Keep Playwright selectors isolated in `@zyquor/browser`.
- Keep generation provider logic outside UI and browser packages.
- Keep account profile paths visible in account config.
- Treat browser failures as persisted states, not console-only errors.
- Approval writes a normalized text fingerprint and rejects duplicate text for the same account.
- API refuses browser jobs for disabled or `draft_only` accounts.
- Controlled post click checks the account's daily post limit before browser automation.
- Draft generation goes through `@zyquor/generation`; UI and browser code never call LLM APIs directly.

## Local Data

Runtime data should live under:

```text
data/
  app.sqlite
  app.json
  artifacts/
profiles/
```

These paths are ignored because they can contain session state and debug artifacts.

## API Routes

Core workflow:
- `POST /drafts` — generate candidates from idea
- `GET /drafts/:id` — get draft with candidates
- `POST /drafts/:id/select` — select candidate, optionally edit text
- `POST /drafts/:id/approve` — approve with optional mode/scheduledFor → creates job
- `GET /jobs?accountId=` — list jobs filtered by account
- `POST /jobs/:id/prepare` — dry-run or real browser prepare
- `POST /jobs/:id/post` — explicit post click (requires enable flag)
- `POST /jobs/post-ready` — queue all ready jobs (approved/prepared/failed, shuffled)
- `DELETE /jobs/:id` — delete non-running job

Batch:
- `POST /draft-batches` — create multiple jobs from one idea/line, optional schedule spacing

Source packets:
- `GET /source-packets?accountId=` — list packets
- `POST /source-packets` — create packet
- `POST /source-packets/:id/draft` — generate draft from packet → marks packet drafted

Ingest configs (CRUD for automated source ingestion):
- `GET /ingest-configs?accountId=` — list configs
- `POST /ingest-configs` — create config
- `PATCH /ingest-configs/:id` — update config
- `DELETE /ingest-configs/:id` — delete config

Style profiles:
- `GET /style-profiles/:id` — get profile
- `PATCH /style-profiles/:id` — update tone/rules/bannedPhrases/systemPromptExtra

Generation config:
- `GET /generation` — current provider/model
- `PATCH /generation` — change provider/model at runtime

Browser:
- `GET /browser/x-session?accountId=` — check X login state
- `POST /jobs/:id/prepare` — prepare (writes text to X compose, dry-run or real)
- `POST /jobs/:id/post` — click Post (real submit, requires enable flag)

History:
- `GET /history` — posted tweet history
- `GET /jobs/:id/attempts` — attempt logs for a job

## Smoke Tests

Use these when dependencies or browser access are unavailable:

```bash
pnpm smoke
pnpm smoke:http
```

`smoke:http` tries to bind a local HTTP server. In restricted sandboxes that reject listeners with `EPERM`, it falls back to the same workflow in-process and reports `networkBlocked`.

If `pnpm dev:api` or `pnpm dev:web` fails with `listen EPERM`, the sandbox is blocking local servers. Run the same commands in a normal terminal session.

## Local Runbook

Create `.env` from the checked-in template before using real providers:

```bash
cp .env.example .env
```

For Gemini, set these values in `.env`, then run the generation smoke:

```text
ZYQUOR_LLM_PROVIDER=gemini
ZYQUOR_GEMINI_API_KEY=your_key_here
ZYQUOR_GEMINI_MODEL=gemini-2.5-flash
```

```bash
pnpm smoke:generation
```

For a fast local Ollama smoke, use a small model:

```bash
ollama serve
ollama pull tinyllama
ZYQUOR_LLM_PROVIDER=ollama ZYQUOR_OLLAMA_MODEL=tinyllama pnpm smoke:generation
```

Run the API and web UI in separate terminals:

```bash
pnpm dev:api
pnpm dev:web
```

The API defaults to `http://127.0.0.1:3000`. The web UI reads `ZYQUOR_API_URL` and defaults to the same API URL.

Real X browser prepare prerequisites:

- Install Playwright Chromium once with `pnpm --filter @zyquor/browser exec playwright install chromium`.
- Use a dedicated account profile under `profiles/`; do not reuse an everyday browser profile.
- Open the profile with `pnpm profile:x`, then log into X there.
- If X blocks Playwright-controlled login, use `pnpm profile:x:manual`, log in, then close Chrome.
- If `.env` sets `ZYQUOR_BROWSER_CDP_URL`, start `pnpm profile:x:cdp` and keep that Chrome window open while preparing or posting.
- Verify the persisted login with `pnpm profile:x:check`.
- In the web UI, use `Check X` in the account strip before preparing a real job.
- Start with `ZYQUOR_ENABLE_BROWSER_PREPARE=1 pnpm dev:api`.
- Set `ZYQUOR_ENABLE_BROWSER_POST=1` only when final public Post click should be enabled.
- Default `ZYQUOR_BROWSER_CHANNEL=chromium` uses bundled Playwright Chromium. Use `chrome` only if Chrome is installed.
- Browser pacing defaults to slow actions and typed input. Configure `ZYQUOR_BROWSER_ACTION_DELAY_MS` and `ZYQUOR_BROWSER_TYPING_DELAY_MS`.

## LLM Providers

Provider selection uses environment variables:

```bash
ZYQUOR_LLM_PROVIDER=mock
ZYQUOR_LLM_PROVIDER=ollama ZYQUOR_OLLAMA_BASE_URL=http://127.0.0.1:11434 ZYQUOR_OLLAMA_MODEL=llama3.1
ZYQUOR_LLM_PROVIDER=gemini ZYQUOR_GEMINI_API_KEY=... ZYQUOR_GEMINI_MODEL=gemini-2.5-flash
```

`mock` is deterministic and offline. `ollama` calls `/api/generate` with `stream: false` and JSON output. `gemini` calls Gemini `models/{model}:generateContent` with JSON response config.
