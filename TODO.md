# Zyquor TODO

## Done

- V1 core: idea → candidates → review/edit → approve → prepare/post
- `mock`, `ollama`, `gemini` providers with runtime switching
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

## Next

**Ingest runner** — next major feature. Worker polls enabled ingest configs, creates source packets on schedule, generates drafts, approves jobs. Needs:

- `POST /ingest-run` endpoint (triggered by worker or cron)
- Source adapter interface for feed/news URL inputs
- Tweet type selection from `tweetTypeMix` weights
- Daily packet count enforcement per config
- Schedule window time-of-day guard

**Reply drafting** — explicit reviewable job for reply tweets. Needs:

- Reply target tracking (tweet ID, author handle, thread context)
- Reply draft generation from source packet or direct idea
- Reusable in normal single/batch/yolo flows

## Deferred

- Multi-account UI (accounts exist in storage, web UI uses one at a time)
- Voice input package
- Tauri desktop wrapper
- E2E test suite (Playwright)
