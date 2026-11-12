# Architecture Notes

Zyquor is a local-first X posting assistant built as one Cargo workspace. The whole runtime is Rust; the only TypeScript left is the React renderer in `apps/web`.

Core flow:

```text
idea/source -> draft candidates -> select/edit -> approve -> durable job
            -> worker -> browser prepare/post -> post history
```

Automated source lane:

```text
ingest config -> source adapter -> source packet -> automation
              -> one generated draft -> approved autopost job
```

Reply lane:

```text
feed / mention / post URL -> reply draft -> review or capped auto-approval
                          -> ordinary post job
```

The LLM only writes candidate text. Scheduling, ranking, browser automation, and the final post decision live outside `zyquor-generation` and are separately gated.

## Crate Graph

```text
zyquor-core                     no internal dependencies
  -> zyquor-accounts            core
  -> zyquor-generation          core
  -> zyquor-adapters            core
  -> zyquor-browser             core
  -> zyquor-storage             core, accounts

zyquor-automation               core, adapters, generation, storage

apps/api                        all seven crates
apps/worker                     core (HTTP client to the API; no database access)
apps/desktop                    api, worker, browser, storage, accounts, core
apps/cli                        all seven crates, api, worker
apps/web                        React/Vite renderer; not a Cargo member
```

Dependency direction is deliberate: domain crates never depend on an app crate, and `apps/api` is the composition root. `zyquor-browser` depends only on `zyquor-core`; `zyquor-generation` never depends on storage, browser, or UI; `zyquor-storage` never talks HTTP or launches a browser.

## Boundaries

- `zyquor-core`: domain enums and wire values, lifecycle transitions, path and per-profile CDP rules, post spacing, reply-target parsing. No I/O beyond environment/path helpers.
- `zyquor-accounts`: account records and dedicated-profile safety checks. Rejects everyday Chrome profile paths; profiles must stay under `profiles/`.
- `zyquor-storage`: the only persistence layer. SQLite schema, migrations, repositories, and model mapping via rusqlite.
- `zyquor-generation`: provider selection and clients, prompt assembly, answer parsing, the refine loop, deterministic post-processing and quality scoring. It returns text only.
- `zyquor-adapters`: network source adapters behind a `Fetch`/`CrawlService` seam, the aggregator with per-source health, and the Goldfish memory adapter.
- `zyquor-automation`: ingest orchestration, source packets, packet-to-draft derivation, tweet-type routing, quality gates, and performance aggregation. It composes adapters, generation, and storage.
- `zyquor-browser`: direct Chrome DevTools Protocol automation through `chromiumoxide`: session/page primitives, login detection, feed fetchers, composer, delete flow, launch state, and the Chrome launcher.
- `apps/api`: axum 0.8 HTTP surface and orchestration. It builds the generation provider, source adapters, repository proxy, and browser dependencies.
- `apps/worker`: the polling loop. It drives the API over HTTP and never opens the database directly.
- `apps/desktop`: Tauri v2 shell. It starts the API and worker in-process, owns the window/tray/settings/log/Chrome lifecycle, and injects the desktop control plane.
- `apps/cli`: the `zyquor` operational binary: dev runner, profiles/login checks, posting loops, audits, backfills, seeding, evaluation, generation smoke.
- `apps/web`: React + Vite UI. In the desktop app it runs inside the Tauri webview with `window.zyquor.apiBaseUrl`; in standalone dev it calls `/api`, which Vite proxies to the API.

## Data Flow

1. **Draft.** `POST /drafts` or a batch creates a draft. `POST /drafts/:id/generate` asks `zyquor-generation` for candidates; source-packet routes derive the idea from a packet under `zyquor-automation`. Candidates carry provider, model, rank, and deterministic quality score.
2. **Selection and approval.** `POST /drafts/:id/select` records the chosen text and edit. `POST /drafts/:id/approve` applies the posting mode and optional schedule and creates the durable job. Approval writes the normalized text fingerprint and rejects duplicate approved text for the same account. Agents send `screened: true`, which rejects unclean, over-length, or below-floor text with 409.
3. **Job.** Job statuses follow `created -> approved -> queued -> running -> prepared|posted|failed`. `prepared` can still run or post; `failed` is re-armed only through the verify-then-retry path. Attempt rows record every browser run.
4. **Worker.** The worker polls every 5 seconds. It recovers stale `running` jobs, lists approved jobs by account, applies quiet hours, schedule time, and spacing, then calls prepare for `prepare_only`/`scheduled` jobs and post for `autopost` when the post flag is on. The API enforces the account's daily limit before the browser runs. The worker also drives pending draft generation, new source packets, ingest, performance refresh, heartbeats, and the optional mention lanes.
5. **Browser.** The API resolves the account's profile and per-profile CDP URL, checks that X is logged in as the expected handle, then runs the composer flow. Prepare types and verifies text without submitting. Post performs the explicit click and verifies the resulting permalink. Failures store attempt status, error, screenshot, and trace artifacts.
6. **History.** A successful post writes a history row with source metadata, so posted text is traceable back to draft, source packet, source URL, and tweet type. Measurements feed `/history/analysis` and `/performance`.

`POST /jobs/post-next` and `POST /jobs/post-ready` are explicit API paths for draining approved jobs without the worker. They use the same gated browser post path.

## Automated Ingest and Source Health

Ingest configs select adapters, a daily packet target, an optional schedule window, and a tweet-type mix. `zyquor-automation` pulls items through `zyquor-adapters`, rejects undated items and items older than 48 hours, derives a compact source packet, and generates one draft. Auto-approval still creates an ordinary autopost job; the worker and browser flags decide whether it can run.

The aggregator tracks per-upstream last success/failure, item count, error, consecutive failures, and cooldown expiry. Repeated empty or failing runs put that upstream in a short cooldown, keeping ingest cycles focused on sources currently returning data.

A source packet can reach at most two posted history rows per account. Browser posting is never retried automatically after a failure because the click may already have reached X.

## Reply Lane

`GET /replies/feed`, `GET /replies/mentions`, and `POST /replies/from-url` discover targets and create reply drafts through the same draft pipeline. Mentions are limited to a 48-hour window, promoted posts are dropped, and scan-and-draft is capped per call. Dedupe normalizes `x.com` and `twitter.com` links and checks both existing drafts and post history.

Goldfish memory is resolved before drafting (wiki facts and recent activity through the local MCP adapter, with a 10-minute cache and 60-second negative cache). Rendered memory is capped at 1600 characters inside `<personal-memory>` and is additive only: failure to fetch it never fails a draft. The per-account style rule `rules.replyMemory` controls it; a request can override it with `useMemory`.

The worker's mention lanes are opt-in. Auto-draft only creates drafts for review. Auto-approve may approve at most `ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP` qualifying top candidates per account per local day, and only above the quality floor; the result is an ordinary `review_required` job. The post path still enforces the browser post flag and daily limit. Neither lane posts by itself.

## Generation Boundary

Only `zyquor-generation` knows provider wire formats. `apps/api` resolves the config and constructs the provider; draft, reply, source-packet, and smoke paths call the provider interface. Browser code never calls an LLM, and generation never browses.

Supported providers:

| Provider | Transport | Default |
| --- | --- | --- |
| `opencode` | authenticated local CLI, `opencode run -m <model>#<variant>` | `opencode/glm-5.3-flash-free`, variant `high` |
| `command-code` | authenticated local CLI, plan/print mode | `gpt-5.6-luna` |
| `gemini` | HTTPS `models/{model}:generateContent` | `gemini-3.6-flash` |
| `ollama` | local HTTP `/api/chat` | `gemma4:e4b` at `http://127.0.0.1:11434` |

`ZYQUOR_LLM_PROVIDER` may be unset or `auto`, in which case Gemini is chosen when `ZYQUOR_GEMINI_API_KEY` is set and Ollama otherwise. The opencode ladder is limited to the approved three models; failover triggers only on the CLI's quota, unavailable-model, or funds shutters.

Config resolution: saved `data/generation.json` (written by `PATCH /generation`) > process environment > desktop settings snapshot. `.env` is loaded into the process environment at startup by `zyquor_core::dotenv` (existing variables win). The saved file wins over both; restart the process to apply a change to the live provider.

Generation asks for candidates with a full prompt per attempt, with bounded best-of-N top-ups when the model returns fewer candidates than requested; a parse failure gets one simpler line-prompt retry. Voice, style, banned phrases, source boundary, and reply context travel in the system and user prompts. `score_tweet_quality` is a deterministic floor, not a ranker; there is no LLM judge in the production path. `ZYQUOR_QUALITY_MIN` defaults to 7 for posts and `ZYQUOR_REPLY_QUALITY_MIN` to 5 for replies. The optional `ZYQUOR_REVISION_PASS` adds a cut-only second pass for opencode. `zyquor tweet-eval` is a development evaluation tool with its own judge, not part of the posting pipeline.

## Persistence and Runtime Rules

- Persistence is SQLite via rusqlite (`app.sqlite` under the data root). There is no JSON fallback; schema creation and column migrations run on open.
- Desktop settings live in `settings.json` in the data root. API keys are currently plaintext; legacy `enc:v1:` values are stripped on load. Logs live in `<dataRoot>/logs/main.log` and rotate to `main.log.1` at 5 MB.
- Browser automation is direct CDP over dedicated Chrome profiles. No stealth, anti-detection, proxy rotation, or CAPTCHA bypass; no automated follows, likes, reposts, DMs, or engagement loops.
- `ZYQUOR_ENABLE_BROWSER_PREPARE=1` and `ZYQUOR_ENABLE_BROWSER_POST=1` gate prepare and the final click separately. The final post action is explicit and logged.
- Each account has its own profile, CDP port, daily post limit, quiet hours, and posting mode. Different accounts may run browser jobs concurrently; one account runs at most one browser job at a time.
- Failed external post jobs are not auto-retried. `POST /jobs/:id/retry` verifies whether the post actually landed before re-arming it, and `POST /jobs/recover-stale` exists for the worker's stale-run recovery.
