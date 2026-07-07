# Plan 003: Add a GitHub Actions CI workflow (build + typecheck + tests)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 91f3988..HEAD -- package.json pnpm-workspace.yaml`
> If the scripts in `package.json` changed, reconcile the workflow's commands
> with the live scripts before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-fix-date-sensitive-history-test.md (CI on a red suite trains everyone to ignore it)
- **Category**: dx
- **Planned at**: commit `91f3988`, 2026-06-12

## Why this matters

The repo has no `.github/` directory — zero CI. Verification (`pnpm test`,
`pnpm check`) exists but only runs when someone remembers. Two regressions
already landed exactly this way: a date-sensitive test rotting on master, and
an OpenRouter model-allowlist change that broke five generation tests without
anyone noticing. This repo is developed largely by agents; an automated gate
that runs on every push is the highest-leverage guard available for an hour of
work.

## Current state

- No `.github/` directory exists.
- Root `package.json` (commit `91f3988`) scripts:
  - `"test": "pnpm build && pnpm -r test"` (vitest per package)
  - `"check": "pnpm build && pnpm -r check"` (per-package typecheck)
  - `"build": "pnpm -r --sort build"`
  - `"packageManager": "pnpm@10.30.3"`
- Workspace: `pnpm-workspace.yaml` with `apps/*` and `packages/*`.
- **Runtime constraint**: `packages/storage` uses `node:sqlite`, which
  requires Node 22.5+ (still flagged experimental in some versions; local dev
  machine runs Node 24.16.0 via nvm). CI must use Node 24.x to match.
- **Network constraint**: unit tests use injected `fetch` fakes — they should
  not need network beyond package install. Browser/Playwright tests are
  skipped without a real Chrome/CDP session (recon observed
  `1 passed | 4 skipped` in `packages/browser`); CI must tolerate skips and
  must NOT try to install Chrome or post anything.
- Posting is gated by env flags `ZYQUOR_ENABLE_BROWSER_PREPARE` /
  `ZYQUOR_ENABLE_BROWSER_POST` defaulting to off — do not set them in CI.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Local dry run of CI steps | `pnpm install --frozen-lockfile && pnpm check && pnpm test` | exit 0 |
| Workflow lint (if available) | `gh workflow list` after push, or `actionlint .github/workflows/ci.yml` if installed | no errors |

Note: if `pnpm` is not on PATH locally, use `node "$(npm root -g)/pnpm/bin/pnpm.cjs"` (per CLAUDE.md).

## Scope

**In scope**:
- Create `.github/workflows/ci.yml` (the only file).

**Out of scope** (do NOT touch):
- Any source or test file. If CI exposes a failing test, report it; do not fix
  it inside this plan.
- No release/publish/deploy jobs. No scheduled jobs. No secrets configuration.
- Do not add lint/prettier — the repo has no lint config; introducing one is a
  separate decision.

## Steps

### Step 1: Create the workflow

Create `.github/workflows/ci.yml` with exactly this shape (adjust only if the
drift check showed script changes):

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        # version is read from "packageManager" in package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm test
```

**Verify**: `cat .github/workflows/ci.yml` matches; YAML parses
(`node -e "require('js-yaml')"` is NOT available — instead rely on actionlint
if installed, otherwise visual check plus Step 3).

### Step 2: Local equivalence run

Run the same three commands locally in order:
`pnpm install --frozen-lockfile && pnpm check && pnpm test`

**Verify**: exit 0. If `pnpm test` fails on the api history-purge test, plan
001 has not landed — STOP (dependency violated).

### Step 3: Push on a branch and observe

Create branch `advisor/003-add-ci`, commit the single file (message:
`Add CI workflow for build, typecheck, and tests`), push, and watch the run:
`gh run watch` (or `gh run list --workflow=ci.yml --limit 1`).

Do this only if the operator allows pushing; otherwise hand the branch over
and mark the plan IN PROGRESS with a note.

**Verify**: the workflow run completes green on GitHub.

## Test plan

The workflow itself is the test. Green run on the branch = pass. No source
tests are added or changed.

## Done criteria

- [ ] `.github/workflows/ci.yml` exists and is the only changed file (`git status`)
- [ ] Local `pnpm install --frozen-lockfile && pnpm check && pnpm test` exits 0
- [ ] One green workflow run visible via `gh run list --workflow=ci.yml`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `pnpm test` is red locally before your change (dependency on plan 001 not met).
- The repo has no GitHub remote or `gh` is unauthenticated — deliver the file,
  skip Step 3, and say so in the status note.
- CI fails for an environment reason you cannot fix inside the single workflow
  file (e.g. `node:sqlite` unavailable on the chosen Node version — try Node 24
  exactly, then STOP rather than pinning exotic versions).
- Anything asks for repository secrets. CI here needs none; a step that wants
  one is out of scope.

## Maintenance notes

- When Playwright/browser E2E tests become runnable headlessly, they should get
  a separate optional job, not be folded into this one — keep the core gate fast.
- If a lint config is introduced later, add `pnpm lint` as a step after
  `pnpm check`.
- Dependabot/renovate config is a natural follow-up but intentionally deferred.
