# Zyquor Plan

## Project Name

`Zyquor`

## Product Goal

Build a local-first assistant for drafting, reviewing, scheduling, and posting X content through dedicated browser profiles. The system should remove manual copy-paste, keep account state isolated, preserve user control, and make every generated post auditable from idea to browser action.

The project starts as a single-account review-first assistant. Multi-account posting, voice input, desktop shell, and richer automation are future phases after the core workflow is reliable.

## Design Position

The strongest architecture is TypeScript-first:

- Playwright is best supported in TypeScript.
- Browser automation will be the most fragile part, so it should use the strongest official ecosystem.
- Rust is useful later for a Tauri desktop shell, not for the initial Playwright core.
- Go is not needed in V1. It can be reconsidered later for a daemon or service wrapper if the app grows.

## Non-Goals

- Do not use the X API in the initial product direction.
- Do not automate follows, likes, reposts, DMs, or engagement loops.
- Do not use the user's everyday Chrome profile directly.
- Do not start with full multi-account autoposting.
- Do not add browser-use as the production posting engine.
- Do not build stealth, anti-detection, proxy rotation, CAPTCHA bypassing, or evasion features.
- Do not add Rust/Tauri until the browser workflow and local UI are proven.

## V1 Scope

V1 should prove one reliable path:

```text
rough idea -> generated draft candidates -> review/edit -> approve -> open X compose in dedicated Chrome profile -> insert approved text -> explicit post action -> log outcome
```

The first implementation should support one account only. It should not try to solve voice, scheduling, Tauri, or multi-account posting until the draft-to-browser path is stable.

## V1 Feature Set

- Local web UI.
- One configured X account.
- One dedicated Chrome persistent profile for that account.
- Manual account login inside that profile.
- Text idea input.
- Mock generation provider first.
- Later: real LLM provider adapter.
- Candidate draft list.
- Edit selected draft.
- Approve draft for posting.
- Worker opens X compose and inserts text.
- Explicit final post action.
- Attempt logs.
- Screenshots/traces on browser failure.
- SQLite persistence.

## Account Modes

### `draft_only`

The app generates and stores drafts only. It does not open X.

### `prepare_only`

The app opens X and inserts the approved draft into the compose box. The user manually completes the post.

### `review_required`

The user explicitly approves a draft and a posting job. The worker can complete the post flow after that approval.

### `scheduled`

Future mode. User approves a post and schedules it for a later time.

### `autopost`

Future mode. Should be limited to non-personal accounts after strong validation, duplicate checks, logs, and account-level limits exist.

V1 should default to `prepare_only` or `review_required`.

## Recommended V1 Stack

- Runtime: Node.js
- Language: TypeScript
- Package manager: pnpm
- Workspace: pnpm workspaces
- UI: Vite + React
- Local API: Fastify
- Browser automation: Playwright
- Browser channel: Chrome
- Browser profile model: Playwright persistent context per account
- Storage: SQLite
- DB layer: Drizzle
- Validation: Zod
- Testing: Vitest
- Browser debugging: Playwright screenshots and traces
- LLM integration: provider adapter with OpenAI-compatible request/response shape

## Future Stack Additions

- Voice input: transcription adapter, likely local Whisper-compatible sidecar or hosted speech-to-text.
- Desktop app: Tauri shell after the local web UI is stable.
- Rust: Tauri shell, tray, global hotkey, notifications, native mic/file permissions, local config helpers.
- Go: optional later for a standalone daemon, not needed in the initial design.
- Embeddings: optional duplicate/similarity checks for account memory and cross-account content separation.

## Repository Structure

```text
zyquor/
  apps/
    web/
    worker/
  packages/
    accounts/
    browser/
    core/
    generation/
    storage/
    voice/
  data/
    app.sqlite
    artifacts/
  docs/
  profiles/
    personal-main/
  scripts/
```

## Module Responsibilities

## `apps/web`

Local browser UI for:

- account selection
- idea entry
- draft candidate review
- draft editing
- approval
- job queue
- post history
- style profile editing
- account settings
- failure inspection

The UI should be an operational tool, not a marketing page.

## `apps/worker`

Background process for:

- polling approved jobs
- launching Playwright
- opening account-specific Chrome profile
- navigating to X compose
- inserting approved text
- optionally completing the post flow
- recording attempt state
- saving screenshots/traces on failure

The worker should process one active browser job per account at a time.

## `packages/core`

Shared domain model:

- IDs
- enums
- state machines
- validation contracts
- job lifecycle
- error types
- common utility types

Important state machines:

- draft lifecycle
- post job lifecycle
- browser attempt lifecycle

## `packages/accounts`

Account configuration:

- X handle
- display name
- browser profile directory
- style profile link
- posting mode
- daily limits
- quiet hours
- enabled/disabled state

This package should make profile isolation explicit and hard to bypass.

## `packages/browser`

Playwright browser layer:

- launch persistent Chrome context
- validate profile directory
- open X
- detect login state
- open compose
- insert post text
- verify inserted text
- execute explicit post action when allowed
- collect screenshots/traces
- fail safely on unknown UI states

No generation logic should live here.

## `packages/generation`

Content generation layer:

- style profile loading
- prompt assembly
- provider interface
- mock provider
- real provider adapters
- candidate generation
- rewrite passes
- scoring
- banned phrase checks
- duplicate checks

Generation should be staged rather than a single prompt that directly outputs final content.

## `packages/storage`

SQLite persistence:

- schema
- migrations
- repositories
- transactions
- query helpers

Writes involving draft approval and job creation should be transactional.

## `packages/voice`

Future voice layer:

- audio capture metadata
- transcription provider interface
- transcript cleanup
- voice note to idea conversion

This package can remain a placeholder until the text workflow is stable.

## Browser Profile Strategy

Each X account must use a dedicated Chrome user data directory:

```text
profiles/
  personal-main/
  ai-topic-founder/
  ai-topic-saas/
  ai-topic-devtools/
```

Rules:

- Never point Playwright at the user's everyday Chrome profile.
- Login happens manually once inside the dedicated profile.
- Session cookies stay inside that profile.
- Account config owns the mapping from account ID to profile path.
- Profile directories should not be committed to Git.

## Generation Strategy

The generation pipeline should use separate stages:

1. Normalize the user's idea.
2. Extract the core claim, audience, and intended tone.
3. Generate multiple candidate drafts.
4. Apply account-specific style rules.
5. Remove generic phrasing and vague filler.
6. Validate length and formatting.
7. Check banned phrases.
8. Check duplicate or near-duplicate content.
9. Present candidates for review.

Style profiles should include:

- tone
- point of view
- sentence length preference
- hook style
- CTA policy
- emoji policy
- hashtag policy
- formatting preferences
- banned phrases
- example posts
- notes from the user

## Data Model Draft

## `accounts`

- `id`
- `handle`
- `display_name`
- `profile_dir`
- `style_profile_id`
- `posting_mode`
- `enabled`
- `daily_post_limit`
- `quiet_hours_start`
- `quiet_hours_end`
- `created_at`
- `updated_at`

## `style_profiles`

- `id`
- `name`
- `description`
- `tone`
- `rules_json`
- `banned_phrases_json`
- `example_posts_json`
- `created_at`
- `updated_at`

## `drafts`

- `id`
- `account_id`
- `source_type`
- `source_input`
- `generated_text`
- `edited_text`
- `status`
- `created_at`
- `updated_at`

## `draft_candidates`

- `id`
- `draft_id`
- `text`
- `score_json`
- `selected`
- `created_at`

## `post_jobs`

- `id`
- `account_id`
- `draft_id`
- `status`
- `mode`
- `scheduled_for`
- `approved_at`
- `created_at`
- `updated_at`

## `post_attempts`

- `id`
- `job_id`
- `status`
- `error_code`
- `error_message`
- `screenshot_path`
- `trace_path`
- `started_at`
- `finished_at`

## `post_history`

- `id`
- `account_id`
- `draft_id`
- `posted_text`
- `post_url`
- `posted_at`

## `content_fingerprints`

- `id`
- `account_id`
- `draft_id`
- `text_hash`
- `normalized_text`
- `embedding_ref`
- `created_at`

Embeddings are optional in the early version. Start with hashes and normalized text comparisons.

## Job Lifecycle

Post job states:

```text
created
approved
queued
running
prepared
posted
failed
cancelled
```

Attempt states:

```text
started
compose_opened
text_inserted
post_clicked
verified
failed
```

The app should store enough state to resume or inspect a failed job without guessing what happened.

## Safety And Reliability Guardrails

- Require explicit approval in V1.
- Keep full local audit history.
- Capture artifacts on failure.
- Use one active browser job per account.
- Stop when login is required.
- Stop when compose box cannot be found.
- Stop when inserted text cannot be verified.
- Stop on unknown confirmation or warning dialogs.
- Avoid duplicate posts.
- Avoid near-duplicate posts across accounts.
- Keep account limits explicit.
- Make every automatic action visible in history.

## Multi-Account Future Plan

Multi-account support should be built in phases.

## Phase A: Multi-Account Configuration

- Add multiple account records.
- Add one dedicated profile directory per account.
- Add account selector in UI.
- Add per-account style profiles.
- Add per-account job queue.
- Add per-account post history.

No autoposting yet.

## Phase B: Multi-Account Review Workflow

- Generate drafts for selected account.
- Review/edit/approve per account.
- Run one job at a time per account.
- Prevent concurrent jobs for the same account.
- Add account status indicators.

Still review-first.

## Phase C: Cross-Account Content Separation

- Add duplicate checks across all accounts.
- Add near-duplicate scoring.
- Add topic/persona separation rules.
- Add per-account banned themes and phrases.
- Warn before posting similar content across accounts.

This phase is required before any serious multi-account scheduling.

## Phase D: Scheduling

- Add approved scheduled jobs.
- Add queue view by account and time.
- Add quiet hours.
- Add daily limits.
- Add missed-job handling.
- Add manual pause/resume.

Scheduling should operate only on already approved content at first.

## Phase E: Limited Autoposting

Only after the review and scheduling system is stable:

- Enable account-level `autopost`.
- Require style profile and limits before enabling.
- Require duplicate checks before posting.
- Require visible post history and failure logs.
- Keep personal account in `review_required` by default.

Autopost should be a per-account setting, not a global switch.

## Phase F: Voice Input

- Add mic recording to local UI or desktop shell.
- Transcribe voice to text.
- Clean transcript into an idea.
- Feed idea into the existing generation pipeline.
- Keep review/edit before posting.

Voice should not bypass review.

## Phase G: Tauri Desktop Shell

Add Tauri when the web app and worker are stable:

- desktop window
- tray icon
- global hotkey
- native notifications
- launch worker
- manage local app lifecycle
- mic/file permissions

The Rust side should stay thin. The Playwright worker should remain TypeScript.

## Development Milestones

## Milestone 0: Foundation

- Initialize Git repo.
- Add `PLAN.md`.
- Add `CLAUDE.md`.
- Add `.gitignore`.
- Add pnpm workspace.
- Add TypeScript config.
- Add initial package layout.

## Milestone 1: Core Types And Storage

- Define account, style, draft, job, and attempt types.
- Add Zod schemas.
- Add SQLite schema.
- Add migrations.
- Add repositories.
- Add tests for validation and state transitions.

## Milestone 2: Local API

- Add Fastify app.
- Add routes for accounts, styles, drafts, jobs, and history.
- Add health endpoint.
- Add local config loading.

## Milestone 3: Local UI

- Add account selector.
- Add idea input.
- Add draft candidate review.
- Add editor.
- Add approve button.
- Add queue view.
- Add history view.

## Milestone 4: Generation

- Add mock provider.
- Add prompt builder.
- Add style profile application.
- Add candidate scoring.
- Add real provider adapter behind environment config.

## Milestone 5: Browser Prepare Flow

- Add Playwright dependency.
- Launch Chrome persistent context.
- Open account-specific profile.
- Detect login state.
- Open X compose.
- Insert approved text.
- Verify inserted text.
- Save screenshot/trace on failure.

This milestone should stop before full post submission unless explicitly enabled.

## Milestone 6: Controlled Posting

- Add explicit post action.
- Verify success.
- Store post history.
- Improve failure classification.
- Add retry only for clearly recoverable failures.

## Milestone 7: Multi-Account Basics

- Add multiple accounts.
- Add profile directory mapping.
- Add per-account queues.
- Add per-account style profiles.
- Add one-active-job-per-account enforcement.

## Milestone 8: Scheduling

- Add scheduled jobs.
- Add quiet hours.
- Add per-account daily limits.
- Add pause/resume.
- Add missed-job handling.

## Milestone 9: Voice

- Add audio input.
- Add transcription adapter.
- Add transcript cleanup.
- Reuse existing draft generation flow.

## Milestone 10: Desktop

- Add Tauri shell.
- Add tray and notifications.
- Add global hotkey.
- Package app.

## First Build Target

The first useful target is intentionally small:

```text
local text input -> mock generated drafts -> review/edit -> save approved job -> launch dedicated Chrome profile -> open X compose -> insert text
```

Once that works, the next target is controlled posting with explicit approval and persistent history.
