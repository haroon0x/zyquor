# Plan 001: Make the history-purge API test pass independently of the real date

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 91f3988..HEAD -- apps/api/src/app.test.ts apps/api/src/app.ts packages/storage/src/memory.ts`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `91f3988`, 2026-06-12

## Why this matters

`pnpm test` fails on a clean checkout: the api test "purges posted tweet
history after 24 hours" expects `POST /jobs/:id/post` to return 200 but gets
409. It passed when written and fails now without any code change, which means
it depends on the real wall-clock date (it pins mocked time to 2026-04-24;
it started failing some time before 2026-06-12). A red baseline means no
other change to this repo can be verified, so this plan must land before any
other plan executes.

## Current state

- `apps/api/src/app.test.ts:828-858` — the failing test. Excerpt as of commit `91f3988`:

  ```ts
  it("purges posted tweet history after 24 hours", async () => {
    let nowMs = Date.parse("2026-04-24T17:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const repository = createMemoryRepository({
      now: () => new Date(nowMs).toISOString()
    });
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => ({ postUrl: "https://x.com/personal/status/ttl" }),
      repository
    });
    // ... creates a draft, approves it with mode "autopost", then:
    expect((await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` })).statusCode).toBe(200);
    ```

  The first assertion (`toBe(200)`) is the one that fails with 409.

- `apps/api/src/app.ts` — the Fastify app (1487 lines). The 409 is produced by
  some precondition check inside the `POST /jobs/:id/post` route. This plan
  does not assume which one; Step 1 finds it.
- `packages/storage/src/memory.ts` — the in-memory repository used by the test;
  its `now` option is injected above, but other code paths may call
  `new Date()` / `Date.parse` directly.
- 36 of 37 tests in this file pass; only this one is date-sensitive.

Repo conventions: TypeScript ESM, vitest, tests colocated as `*.test.ts`.
Existing tests in `apps/api/src/app.test.ts` are the pattern to match.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Build all | `pnpm build` | exit 0 |
| This test only | `cd apps/api && pnpm exec vitest run --pool=threads -t "purges posted tweet history"` | 1 passed |
| Whole api suite | `cd apps/api && pnpm exec vitest run --pool=threads` | 37 passed |
| Full repo tests | `pnpm test` | all packages pass |

Note: if `pnpm` is not on PATH, use `node "$(npm root -g)/pnpm/bin/pnpm.cjs"` in its place (documented in CLAUDE.md).

## Scope

**In scope** (the only files you may modify):
- `apps/api/src/app.test.ts`
- `apps/api/src/app.ts` — only if the root cause is a direct `new Date()` /
  `Date.now()` call in the post route that should come from an injectable clock
  or the repository's `now()`; keep the behavioral logic identical.
- `packages/storage/src/memory.ts` — same constraint: only clock-source
  plumbing, no behavior change.

**Out of scope** (do NOT touch):
- `packages/storage/src/sqlite.ts` — unless the diagnosis proves the same
  unmocked-clock bug exists there, in which case STOP and report instead of
  expanding scope.
- Any posting/browser logic, job state machine transitions, rate-limit values.
- All other failing-test "fixes" — there should be none; see STOP conditions.

## Steps

### Step 1: Reproduce and capture the 409 body

Run the single test and print the response body: temporarily change the failing
assertion to log `response.json()` (or run the route manually) to learn the 409
error message/code. Record it.

**Verify**: the test run output shows the 409 payload (e.g. an error string
naming a daily limit, schedule window, or job state).

### Step 2: Locate the producing check

In `apps/api/src/app.ts`, find the `POST /jobs/:id/post` route handler and
search it (and the functions it calls) for the error string from Step 1.
Identify which time source that check uses: `Date.now()`, `new Date()`, the
repository's `now()`, or stored timestamps compared against real time.

**Verify**: you can state, with a `file:line` reference, the exact comparison
that returns 409 and why it behaves differently when the real date is
2026-06-12 vs when the test was written.

### Step 3: Fix the clock dependency at the right layer

Choose exactly one, in order of preference:

1. If the check reads real time while the test mocks `Date.now` only partially
   (e.g. the check uses `new Date()` which IS affected by the `Date.now` mock —
   not the issue — or reads `repository.now()` which the test wires, etc.),
   make the test mock complete: use `vi.useFakeTimers({ now: ... })` /
   `vi.setSystemTime(...)` instead of spying only on `Date.now`, so every time
   source in the process agrees.
2. If the 409 comes from persisted fixture data with hardcoded dates (e.g. a
   daily-posting-limit counter keyed by calendar day, or account config
   created with a date the mock doesn't control), adjust the test setup so all
   timestamps derive from the single mocked instant.
3. Only if 1–2 are impossible: thread an injectable clock into the specific
   check in `app.ts` (constructor option on `buildApp`, defaulting to
   `() => new Date()`), and have the test inject the mocked clock. Keep the
   production default behavior byte-identical.

Remove any temporary logging added in Step 1.

**Verify**: `cd apps/api && pnpm exec vitest run --pool=threads -t "purges posted tweet history"` → 1 passed.

### Step 4: Prove date independence

Run the full api suite twice with different fake system dates to show no other
test is date-sensitive:

```bash
cd apps/api && pnpm exec vitest run --pool=threads
```

(If the runner supports it, also run with `TZ=UTC` and `TZ=Asia/Kolkata` to
catch timezone assumptions.)

**Verify**: 37 passed in every run.

## Test plan

No new test files. The deliverable is the existing test passing for the right
reason. If Step 2 reveals a real production bug (not just a test-mocking gap),
add one focused regression test next to the failing one in
`apps/api/src/app.test.ts`, modeled on the surrounding tests.

## Done criteria

- [ ] `cd apps/api && pnpm exec vitest run --pool=threads` → 37 passed, 0 failed
- [ ] `pnpm test` from repo root → all packages pass
- [ ] No temporary logging left: `git diff` contains no `console.log` additions
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- More than this one test fails on a clean run before your changes (baseline
  drifted further than this plan assumes).
- The 409 turns out to be correct behavior the test should expect (i.e. the
  product logic intentionally blocks this post and the test premise is wrong)
  — that's a product decision, not a test fix.
- The fix appears to require changing job state machine logic or posting limits.
- The same unmocked-clock pattern exists in `packages/storage/src/sqlite.ts`
  — report it; do not fix it here.

## Maintenance notes

- Any future check in the post route that reads wall-clock time must come from
  a source the tests control; reviewer should reject raw `Date.now()` added to
  that route.
- If a posting-window or daily-limit feature is added later, re-run the suite
  with a far-future fake date before merging.
