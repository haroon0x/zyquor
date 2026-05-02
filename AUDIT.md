# Zyquor Component Audit

## Summary

This audit documents the current workspace as-is, including existing uncommitted changes. No code was changed for this audit.

`git status --short` shows existing modified files in API, web, worker, and generation areas:

```text
 M apps/api/src/app.test.ts
 M apps/api/src/app.ts
 M apps/web/src/main.tsx
 M apps/worker/src/index.test.ts
 M apps/worker/src/index.ts
 M packages/generation/src/index.test.ts
 M packages/generation/src/index.ts
```

Future fixes should avoid mixing audit-only documentation with those reliability changes.

## Verified Issues

### Automation: daily ingest cap can be bypassed after source cleanup

- Component: `@zyquor/automation`
- Evidence: [packages/automation/src/ingest.ts](/home/g/Documents/zyquor/packages/automation/src/ingest.ts:138) lists current source packets, [packages/automation/src/ingest.ts](/home/g/Documents/zyquor/packages/automation/src/ingest.ts:139) filters those packets by source type and current date, and [packages/automation/src/ingest.ts](/home/g/Documents/zyquor/packages/automation/src/ingest.ts:140) compares only that live packet count with `maxPacketsPerDay`.
- Evidence: source packets can be deleted from storage in [packages/storage/src/memory.ts](/home/g/Documents/zyquor/packages/storage/src/memory.ts:211) and [packages/storage/src/sqlite.ts](/home/g/Documents/zyquor/packages/storage/src/sqlite.ts:426).
- Impact: when posted source packets are deleted after posting or cleanup, the ingest runner loses durable evidence that the daily quota was already consumed. A successful cleanup can allow additional packets beyond `maxPacketsPerDay`.
- Recommended next action: record or derive daily ingest usage from durable history, for example a per-config ingest event table or a history query that survives source-packet deletion.

### API: media URL downloads allow arbitrary HTTP(S) fetches without timeout

- Component: `apps/api`
- Evidence: [apps/api/src/app.ts](/home/g/Documents/zyquor/apps/api/src/app.ts:148) defines `downloadMediaUrls`, and [apps/api/src/app.ts](/home/g/Documents/zyquor/apps/api/src/app.ts:158) fetches each provided URL with only a user-agent header. The function validates image content type and final size after the response in [apps/api/src/app.ts](/home/g/Documents/zyquor/apps/api/src/app.ts:162) and [apps/api/src/app.ts](/home/g/Documents/zyquor/apps/api/src/app.ts:166), but no timeout or network target restriction is present.
- Impact: hostile or malformed metadata can make a post job hang on a slow media response, and arbitrary URLs can target internal/private services if such URLs reach the media metadata path.
- Recommended next action: use `AbortController` timeout, stream with a maximum byte limit instead of waiting for the full array buffer, and block localhost/private IP ranges unless explicitly allowed for local development.

### Docs: current documentation is stale in multiple places

- Component: docs
- Evidence: [TODO.md](/home/g/Documents/zyquor/TODO.md:22) still lists the ingest runner as the next major feature, but [apps/api/src/app.ts](/home/g/Documents/zyquor/apps/api/src/app.ts:714) implements `POST /ingest-run`.
- Evidence: [TODO.md](/home/g/Documents/zyquor/TODO.md:18) lists stale test counts; the current `pnpm -r test` output reports 23 API, 7 adapters, 7 core, 12 generation, 5 storage, 6 worker, 2 accounts, 3 browser skipped, and no web/voice tests.
- Evidence: [TODO.md](/home/g/Documents/zyquor/TODO.md:12) and [README.md](/home/g/Documents/zyquor/README.md:84) still use `yolo` wording, while the web UI displays `Autopost` in [apps/web/src/main.tsx](/home/g/Documents/zyquor/apps/web/src/main.tsx:881).
- Evidence: [docs/architecture.md](/home/g/Documents/zyquor/docs/architecture.md:22) says final post clicking remains out of scope and [docs/architecture.md](/home/g/Documents/zyquor/docs/architecture.md:31) omits OpenRouter from supported providers. The API exposes a post endpoint at [apps/api/src/app.ts](/home/g/Documents/zyquor/apps/api/src/app.ts:1093), and generation supports OpenRouter in [packages/generation/src/index.ts](/home/g/Documents/zyquor/packages/generation/src/index.ts:3).
- Impact: stale docs can send future implementation and operations work in the wrong direction.
- Recommended next action: update README, TODO, and architecture docs after the current reliability changes settle.

## Verified Improvements

### Web: refresh performs one attempt request per job

- Component: `apps/web`
- Evidence: [apps/web/src/main.tsx](/home/g/Documents/zyquor/apps/web/src/main.tsx:201) defines `refresh`, [apps/web/src/main.tsx](/home/g/Documents/zyquor/apps/web/src/main.tsx:211) loads jobs, and [apps/web/src/main.tsx](/home/g/Documents/zyquor/apps/web/src/main.tsx:216) maps every loaded job to `GET /jobs/:id/attempts`.
- Evidence: `maxPacketsPerDay` allows up to 300 in [packages/core/src/index.ts](/home/g/Documents/zyquor/packages/core/src/index.ts:219), so job-heavy days can produce hundreds of extra refresh requests.
- Impact: the UI has an N+1 request pattern that can make refresh slow and noisy as job volume grows.
- Recommended next action: add a batch attempts endpoint or include attempts in the jobs response.

### Web: main component owns too many responsibilities

- Component: `apps/web`
- Evidence: `wc -l apps/web/src/main.tsx` reports 1289 lines. The same file owns automation config, source packets, job refresh, attempt display, composer flows, style settings, and model config state.
- Impact: a large all-in-one component raises change risk and makes focused testing harder.
- Recommended next action: split into feature components/hooks for automation, composer, source packets, jobs, settings, and generation model config.

### Adapters: RSS and TechCrunch fetches do not use timeouts

- Component: `@zyquor/adapters`
- Evidence: [packages/adapters/src/rss.ts](/home/g/Documents/zyquor/packages/adapters/src/rss.ts:18) fetches the configured feed URL without timeout options.
- Evidence: [packages/adapters/src/techcrunch.ts](/home/g/Documents/zyquor/packages/adapters/src/techcrunch.ts:26) fetches TechCrunch feeds with a user-agent but no timeout.
- Evidence: Crawl4AI does use an abort timeout in [packages/adapters/src/crawl4ai.ts](/home/g/Documents/zyquor/packages/adapters/src/crawl4ai.ts:14).
- Impact: ingest can stall on slow or non-responsive feed servers.
- Recommended next action: introduce a shared fetch helper with timeout, user-agent, and consistent error handling.

### Storage: duplicate prevention is enforced during approval, not at history insertion

- Component: `@zyquor/storage`
- Evidence: memory storage checks content fingerprints during approval in [packages/storage/src/memory.ts](/home/g/Documents/zyquor/packages/storage/src/memory.ts:405), and SQLite storage checks them in [packages/storage/src/sqlite.ts](/home/g/Documents/zyquor/packages/storage/src/sqlite.ts:665).
- Evidence: SQLite `createPostHistory` inserts rows directly in [packages/storage/src/sqlite.ts](/home/g/Documents/zyquor/packages/storage/src/sqlite.ts:791), and the `post_history` migration has no uniqueness constraint in [packages/storage/migrations/0001_initial.sql](/home/g/Documents/zyquor/packages/storage/migrations/0001_initial.sql:77).
- Impact: normal approval/API posting paths are protected, but future callers that bypass approval can create duplicate history rows.
- Recommended next action: only add repository- or database-level history uniqueness if post history is intended to enforce a global invariant independently from approval.

### Browser: test coverage depends on local Chromium availability

- Component: `@zyquor/browser`
- Evidence: [packages/browser/src/index.test.ts](/home/g/Documents/zyquor/packages/browser/src/index.test.ts:12) checks whether the Playwright Chromium executable exists, and [packages/browser/src/index.test.ts](/home/g/Documents/zyquor/packages/browser/src/index.test.ts:13) skips the suite when it does not.
- Evidence: current `pnpm -r test` output reports `packages/browser` as 1 skipped test file with 3 skipped tests.
- Impact: local and CI coverage for prepare/post behavior depends on browser installation state.
- Recommended next action: ensure CI installs Playwright Chromium or add a separate required browser-test job.

### Voice: package is still a placeholder

- Component: `@zyquor/voice`
- Evidence: [packages/voice/src/index.ts](/home/g/Documents/zyquor/packages/voice/src/index.ts:1) only exports `VoiceNoteMetadata`.
- Evidence: [packages/voice/package.json](/home/g/Documents/zyquor/packages/voice/package.json:16) uses `vitest run --pool=threads --passWithNoTests`, and current test output reports no voice test files.
- Impact: voice input is deferred/incomplete, not a current production feature.
- Recommended next action: keep it documented as deferred until real capture/transcription behavior and tests exist.

## Unsure / Needs Runtime Validation

### Generation: OpenRouter request pricing semantics need provider confirmation

- Component: `@zyquor/generation`
- Evidence: OpenRouter model metadata allows `pricing.request` in [packages/generation/src/index.ts](/home/g/Documents/zyquor/packages/generation/src/index.ts:297), but [packages/generation/src/index.ts](/home/g/Documents/zyquor/packages/generation/src/index.ts:299) only verifies `prompt` and `completion` are zero before allowing generation.
- Impact: if OpenRouter uses nonzero per-request pricing for a model while `prompt` and `completion` remain zero, the current guard could treat that model as free.
- Recommended next action: confirm OpenRouter's current pricing semantics before changing behavior. If `request` is a billable field, include it in the free-pricing guard and add a regression test.

## Verification

- `git status --short`: completed; existing uncommitted changes are listed in the Summary.
- `pnpm build`: passed.
- `pnpm -r test`: passed overall.
- Browser tests: skipped because the Chromium executable was missing; the test suite intentionally uses `describe.skip` in that environment.
- Web and voice tests: no test files found, exiting with code 0 because their package scripts use `--passWithNoTests`.
