# M5 task brief: `apps/api` + `apps/worker` in Rust

## What exists today

- `apps/api` (~9,045 lines): Fastify server, ~20 route modules
  (`accounts`, `drafts`, `replies`, `generation`, `settings`, `onboarding`,
  `source-packets`, `history`, `browser`, …), Zod validation, DI via
  `buildApp({ repository, generationProvider, … })`.
- `apps/worker` (~1,755 lines): polling loop for due jobs, async ingest,
  mention auto-draft/auto-approve, stale-job recovery, per-account concurrency.

## Target

- `apps/api` → `axum` + `tower-http`, same routes, same JSON shapes.
- `apps/worker` → `tokio` with the same scheduling semantics.

## Approach

1. **Freeze the contract first.** Before writing handlers, capture every route's
   request/response as fixtures (method, path, body, status, JSON). Fastify's
   `app.inject` already makes this easy — add a script that dumps them.
   Then the axum server is "done" when it reproduces the fixtures.
2. **Keep `buildApp`-style injection.** The TypeScript tests build the app with
   a fake repository and fake generation provider. Mirror that with traits:
   `trait Repository` and `trait GenerationProvider`, so handler tests need no
   database and no network.
3. **Async/DB rule:** rusqlite is blocking. Wrap every repository call in
   `tokio::task::spawn_blocking`, or run the repository on a dedicated thread
   behind a channel. Do not call it inline in a handler.
4. **Worker concurrency:** accounts are independent — one job at a time *per
   account*, but accounts run in parallel. Use `JoinSet` plus a per-account
   guard (the storage layer already enforces `claim_job_for_browser_run`). Do
   not reintroduce the old global single-account lock; it was removed on
   purpose.
5. **No auto-retry of failed external post jobs.** Keep `stale-job` and
   `recover-running-ingest-runs` recovery, but never re-post.

## Error mapping

`apps/api/src/lib/errors.ts` currently classifies errors by **matching message
strings** (`startsWith("Duplicate ")`, `includes("ZYQUOR_OPENROUTER_API_KEY")`,
…). Do not port that verbatim — replace it with a typed error enum
(`StorageError::NotFound`, `Invalid`, …) mapped to status codes. This is one of
the few places a behaviour-preserving rewrite is still cleaner than a literal
translation; document the mapping in the route tests.

## Exit criteria

- Route fixtures reproduced exactly (status + JSON).
- `pnpm smoke`, `pnpm smoke:http` pass against the Rust API with no client changes.
- Two accounts post concurrently; each enforces its own daily limit, quiet
  hours, gap, and single in-flight browser job.
- Worker restart mid-run recovers without duplicating posts.
