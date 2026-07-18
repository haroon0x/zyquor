# Zyquor TODO

## Done

- V1 core: idea → candidates → review/edit → approve → prepare/post
- `command-code`, `openrouter`, `ollama`, `gemini` providers with runtime switching
- Command Code defaults to DeepSeek v4 Pro with default reasoning in read-only headless mode
- Desktop startup launches or reconnects dedicated posting Chrome
- Windows installer creates desktop and Start menu shortcuts with the Zyquor icon
- Style settings expose account-specific example posts for voice calibration
- Command Code candidates reject missing source URLs and invented numeric details before review or autopost
- Web/API model config for provider and model string
- Browser prepare/post with dedicated Chrome profiles
- Schedule support (mode: `scheduled`, `prepare_only`, `autopost`)
- Batch jobs with deterministic spacing
- Source packets (manual/news/feed/bookmark/note/guide) → draft workflow
- `Yolo autopost` mode (immediate post, no schedule)
- Post-click permalink polling (5s retry loop)
- Ingest config system (CRUD, sourceType, maxPacketsPerDay, tweetTypeMix, scheduleWindow)
- Quiet hours enforcement
- `Post all ready` queue endpoint with randomized job order
- Stale running-job recovery
- Full test suite: 14 API, 7 core, 5 generation, 4 storage, 3 browser, 3 worker, 2 accounts
- Autopost idempotency: worker keeps submitted autopost job IDs in process state, API/storage atomically claim browser jobs, stale running jobs are recovered on worker resume, and failed post jobs are not automatically retried because an interrupted external post may already have reached X.
- Automation autopost uses one generated final tweet, stores source trace in draft metadata, and does not store unused draft candidate rows.
- Browser post defaults are faster but still conservative: 1800ms action delay, 20ms typing delay, with post permalink verification unchanged.
- Browser posting falls back to launching the dedicated profile when Chrome CDP is unavailable.
- Worker status/heartbeat endpoint reports ingest/post state and errors.
- Default news ingest config seed endpoint exists.
- Worker startup warns when no enabled ingest configs exist and can seed default news config.
- Post-history analysis command/API reports duplicate text, repeated topics, missing links, generic phrasing, and weak source attribution.
- Posted history stores source packet/source metadata for traceability.
- Duplicate post detection checks posted history.
- Verified live source smoke covers required adapters; Product Hunt remains optional without API token.
- Hiring adapter and hiring/article-summary tweet types exist.
- Source health for aggregated news tracks failures/empty results and cools bad upstreams down.

## Next

**Maintainability and modularity pass** — codebase now has enough behavior that large files should be split before more features land. Needs:

- Split `apps/api/src/app.ts` into route modules and small services for generation, sources, posting, history cleanup, and cascade deletes
- Split `apps/web/src/main.tsx` into focused components, hooks, and shared option constants
- Split `packages/generation/src/index.ts` into prompt assembly, provider clients, response parsing, post-processing, and config loading
- Split `packages/adapters/src/aggregator.ts` into source registry, source scoring, keyword tagging, and per-source defaults
- Move tweet type and source type option lists into one shared place so API, tests, and web UI cannot drift
- Add service-level tests around cascade delete, post history TTL, dedupe, and source routing

**Async automatic worker reliability** — automatic news posts must run as a background pipeline, not depend on manual clicks. Current local DB has no ingest configs, so the worker has no source to pull. Needs:

- Add UI panel showing worker last ingest time, last post time, errors, and next run
- Make ingest, generation, and posting run as explicit async stages with durable job rows instead of one mostly sequential worker cycle
- Add per-source async fetch concurrency with safe limits
- Add startup check that warns when `ZYQUOR_ENABLE_BROWSER_POST=0`, X login is missing, API is unreachable, or browser posting cannot run
- Keep API, worker, CLI, and analysis tools on one workspace-root DB path
- Keep Chrome CDP alive or recover it before browser post attempts fail
- Add tests for "approved autopost job is posted by worker"

**Fast but safe posting path** — slightly reduce time from source to posted tweet without weakening external-post safety. Needs:

- Keep no automatic retry for failed external post jobs
- Add clearer env knobs for post speed so local runs can tune speed without code changes
- Extend the one-final-tweet path to direct yolo draft generation if direct yolo starts producing unused candidates
- Keep audit rows in post history and source metadata intact

**No draft candidate waste** — save tokens by skipping unused candidate generation when review is not needed. Needs:

- Manual review flow can still ask for multiple candidates
- Add more tests if direct yolo paths are changed later

**Tweet quality review loop** — use the 24h post history as a short feedback window. Needs:

- Quality fixes to target: less generic "AI is changing..." framing, stronger source-specific details, clearer why-it-matters angle, and links when source has one
- End-to-end formatting check: generated line breaks, blank lines, list markers, and timeline lines must stay intact when text is inserted into X compose

**More automated source lanes** — add high-volume but controlled inputs for hiring and blog/article summary posts. Needs:

- Source selection rules that route job posts to hiring and blog/feed posts to article summaries
- Tests proving links and attribution survive generation inputs

**More source ideas** — add diverse inputs for quantity without flooding low-signal posts. Candidates:

- YC Work at a Startup and selected company career feeds for real hiring posts
- Lever/Greenhouse boards for selected AI, infra, devtool, data, and security companies
- GitHub issues labeled `help wanted` or `good first issue` for useful open-source opportunities
- Hugging Face trending models, datasets, and Spaces
- Papers with Code trending and benchmark updates
- Stack Overflow Blog, GitHub Blog, Rust/Python/Node/Kubernetes/CNCF release blogs
- SEC/news feeds for public AI, chip, cloud, and cybersecurity companies
- Product Hunt launches with minimum vote/comment thresholds

**Fresh session implementation order** — use this order when continuing in a new clean run:

- First modularize API/generation/adapters without changing behavior
- Then add speed env tuning
- Then add source routing quality fixes
- Then add next source adapters one at a time with tests

**Reply drafting** — explicit reviewable job for reply tweets. Needs:

- Reply target tracking (tweet ID, author handle, thread context)
- Reply draft generation from source packet or direct idea
- Reusable in normal single/batch/yolo flows

## Deferred

- Multi-account UI (accounts exist in storage, web UI uses one at a time)
- Voice input package
- Tauri desktop wrapper
- E2E test suite (Playwright)
