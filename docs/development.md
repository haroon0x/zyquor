# Development Notes

This repo should stay easy to change as the product grows. Favor explicit contracts over implicit behavior.

## Current Build Order

1. Keep `@zyquor/core` contracts stable first.
2. Keep storage/repository behavior covered before API changes.
3. Keep API and worker behavior covered before UI changes.
4. Keep browser posting behind env flags and persisted attempt logs.

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
- Source ingestion goes through `@zyquor/adapters` and `@zyquor/automation`; generation never browses.

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
- `POST /drafts` — create an ungrounded draft
- `POST /drafts/research` — search fresh sources and generate grounded candidates from a topic or rough post
- `POST /drafts/:id/generate` — generate candidates for an existing draft
- `GET /drafts/:id` — get draft with candidates
- `POST /drafts/:id/select` — select candidate, optionally edit text
- `POST /drafts/:id/approve` — approve with optional mode/scheduledFor → creates job
- `GET /jobs?accountId=` — list jobs filtered by account
- `POST /jobs/:id/prepare` — dry-run or real browser prepare
- `POST /jobs/:id/post` — explicit post click (requires enable flag)
- `POST /jobs/post-ready` — queue all ready jobs (approved/prepared/failed, shuffled)
- `DELETE /jobs/:id` — delete non-running job
- `GET /jobs/:id/attempts` — attempt logs for a job

Batch:
- `POST /draft-batches` — create multiple jobs from one idea/line, optional schedule spacing

Source packets:
- `GET /source-packets?accountId=` — list packets
- `POST /source-packets` — create packet
- `POST /source-packets/:id/draft` — generate draft from packet → marks packet drafted
- `DELETE /source-packets/:id` — delete packet and non-posted generated draft
- `DELETE /source-packets?accountId=` — delete all packets for account when safe

Ingest configs (CRUD for automated source ingestion):
- `GET /ingest-configs?accountId=` — list configs
- `POST /ingest-configs` — create config
- `POST /ingest-configs/default-news` — create/reuse default automated news config
- `PATCH /ingest-configs/:id` — update config
- `DELETE /ingest-configs/:id` — delete config
- `GET /ingest-sources` — list source adapters and aggregated source health
- `POST /ingest-run` — run ingest synchronously
- `POST /ingest-run/async` — queue ingest without blocking worker/API callers

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
- `POST /history/:id/delete` — delete the live X post via the account's posting Chrome (requires browser-post flag), marks the history row deleted
- `GET /history/analysis?accountId=&sinceHours=` — recent post quality analysis

Worker:
- `GET /worker/status` — heartbeat, ingest run state, config state
- `POST /worker/heartbeat` — worker heartbeat

## Smoke Tests

Use these when dependencies or browser access are unavailable:

```bash
pnpm smoke
pnpm smoke:http
pnpm smoke:adapters
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

- Install Playwright Chromium once with `pnpm --filter @zyquor/browser exec playwright install chromium`. **Note:** Playwright bundled Chromium is unsupported on Ubuntu 26.04+. On such systems, install system Google Chrome and use `ZYQUOR_BROWSER_CHANNEL=chrome`.
- On Ubuntu 26.04+, install system Chrome:
  ```bash
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
  sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list'
  sudo apt update && sudo apt install google-chrome-stable
  ```
  Then set in `.env`: `ZYQUOR_BROWSER_CHANNEL=chrome`
- Use a dedicated account profile under `profiles/`; do not reuse an everyday browser profile.
- Open the profile with `pnpm profile:x`, then log into X there.
- If X blocks Playwright-controlled login, use `pnpm profile:x:manual`, log in, then close Chrome.
- If `.env` sets `ZYQUOR_BROWSER_CDP_URL`, start `pnpm profile:x:cdp` and keep that Chrome running while preparing or posting. Set `ZYQUOR_BROWSER_HEADLESS=1` to run it with `--headless=new` (no window); auto-launch honours the same flag.
- Verify the persisted login with `pnpm profile:x:check`.
- In the web UI, use `Check X` in the account strip before preparing a real job.
- Start with `ZYQUOR_ENABLE_BROWSER_PREPARE=1 ZYQUOR_LLM_PROVIDER=openrouter ZYQUOR_OPENROUTER_API_KEY=... pnpm dev:api`.
- Set `ZYQUOR_ENABLE_BROWSER_POST=1` only when final public Post click should be enabled.
- Default `ZYQUOR_BROWSER_CHANNEL=chromium` uses bundled Playwright Chromium. Use `chrome` only if Chrome is installed.
- Browser pacing defaults to slow actions and typed input. Configure `ZYQUOR_BROWSER_ACTION_DELAY_MS` and `ZYQUOR_BROWSER_TYPING_DELAY_MS`.

## pnpm Setup

Do not use the Hermes-bundled pnpm. Install globally via npm:
```bash
npm install -g pnpm
ln -sf $(npm root -g)/pnpm/bin/pnpm.cjs ~/.local/bin/pnpm
```

## Generation Provider Resolution

- Resolution priority: saved `data/generation.json` > `.env` file > shell `process.env`.
- Shell env vars take precedence over `.env` — the dotenv loader skips already-set vars.
- The default provider is `codex` with `gpt-5.6-luna` and high reasoning. Command Code remains available with the same model. The current desktop setup does not use OpenRouter.
- Command Code must be installed and authenticated on the same operating system that runs Zyquor. Set `ZYQUOR_COMMAND_CODE_PATH` when it is not available on `PATH`.
- Codex CLI must be installed and authenticated on the same operating system that runs Zyquor. Set `ZYQUOR_CODEX_PATH` when it is not available on `PATH`.
- Setting `ZYQUOR_LLM_PROVIDER=openrouter` without `ZYQUOR_OPENROUTER_API_KEY` crashes the API on startup. Use `auto` when the key is not ready.
- The OpenRouter fallback is restricted to the free-model allowlist in `OPENROUTER_MODELS` in `packages/generation/src/config.ts`. Setting a model not in the list silently coerces to the default.

## LLM Providers

Provider selection uses environment variables:

```bash
ZYQUOR_LLM_PROVIDER=command-code ZYQUOR_COMMAND_CODE_MODEL=gpt-5.6-luna
ZYQUOR_LLM_PROVIDER=codex ZYQUOR_CODEX_MODEL=gpt-5.6-luna ZYQUOR_CODEX_PATH=codex
ZYQUOR_LLM_PROVIDER=openrouter ZYQUOR_OPENROUTER_API_KEY=... ZYQUOR_OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
ZYQUOR_LLM_PROVIDER=ollama ZYQUOR_OLLAMA_BASE_URL=http://127.0.0.1:11434 ZYQUOR_OLLAMA_MODEL=llama3.1
ZYQUOR_LLM_PROVIDER=gemini ZYQUOR_GEMINI_API_KEY=... ZYQUOR_GEMINI_MODEL=gemini-2.5-flash
```

`command-code` pipes the generation prompt to the authenticated CLI in headless, read-only plan mode. `codex` uses `codex exec` with the `luna` default and high reasoning in ephemeral, read-only, non-interactive mode. `openrouter` uses chat completions. `ollama` calls `/api/generate` with `stream: false` and JSON output. `gemini` calls Gemini `models/{model}:generateContent` with JSON response config.

## Desktop app (Windows)

Zyquor ships as a system-tray Electron desktop app (`apps/desktop`). The API, worker, and web UI run in-process. Starting the app launches or reconnects the dedicated posting Chrome profile.

### Run from native Windows

Run Electron from a native Windows PowerShell session. Do not run the Electron process from WSL or from a `\\wsl$` path.

Use a Windows checkout such as `C:\src\zyquor`. If the source currently lives in WSL, copy it to a Windows path first, then install dependencies there so pnpm installs the Windows Electron binary:

```powershell
robocopy \\wsl$\Ubuntu\home\asus\dev\projects\zyquor C:\src\zyquor /E /XD .git node_modules dist coverage release
Set-Location C:\src\zyquor
pnpm install --frozen-lockfile
pnpm dev:desktop
```

`pnpm dev:desktop` builds the web UI and desktop process, then opens the Zyquor window. The API and worker start inside the same desktop process, so do not start `dev:api`, `dev:web`, or `dev:worker` in separate terminals for this mode. The app uses `%APPDATA%\Zyquor` for runtime data and keeps running in the Windows system tray when its window closes.

Install and authenticate the selected generation CLI in Windows as well. A CLI installed only inside WSL is not available to the native desktop process. If the CLI is not on the Windows `PATH`, set its full path in the desktop Settings panel.

To inspect a running development app and its startup log:

```powershell
Get-Process electron
Get-Content "$env:APPDATA\Zyquor\logs\main.log" -Tail 50
```

```bash
pnpm dev:desktop        # build and launch
pnpm smoke:desktop      # headless logic smoke (no GUI required)
pnpm dist:desktop       # produce NSIS installer (CI: dist-desktop-win job)
```

- **Data root**: `%APPDATA%/Zyquor` on Windows (overridable via `ZYQUOR_DATA_ROOT`).
- **Settings**: `settings.json` in the data root instead of `.env`. UI panel gated on `window.zyquor`.
- **Posting Chrome**: starts with the app and remains available as a tray action, using a dedicated Chrome profile with CDP on port 9222.
- **Main-process logging**: `logs/main.log` under the data root (rotates at 5 MB).
- **Windows releases** use the configured app icon and can be signed through Azure Trusted Signing. See [Windows code signing](code-signing.md).
- **Entry points**: `src/main.ts` (main process), `src/preload.ts` (context bridge), `src/chrome.ts` (CDP launch), `src/settings.ts` (JSON config), `src/log.ts` (file logging).
