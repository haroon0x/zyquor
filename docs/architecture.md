# Architecture Notes

> **Rust migration in progress.** The target architecture is one Cargo workspace: `crates/zyquor-{core,accounts,storage,adapters,generation,automation,browser}` with `apps/api` (axum), `apps/worker`, and `apps/desktop` (Tauri). Package boundaries and runtime rules documented below carry over unchanged. See `docs/rust-migration.md` for the mapping, milestones, and parity requirements.

Zyquor is a local-first X posting assistant. Current system covers manual drafts, source packets, scheduled jobs, autopost jobs, browser prepare/post, automated source ingest, and short-window post-history analysis.

Core flow:

```text
idea/source -> generation -> review/edit or autopost approval -> durable job -> browser prepare/post -> post history
```

Topic flow:

```text
topic or rough post -> fresh topic search -> source packet -> Command Code candidates -> review/edit or autopost approval
```

Automated source flow:

```text
ingest config -> source adapter -> source packet -> one final generated draft -> approved autopost job -> worker/API post path
```

## Reply Flow (replies-first)

Reply drafting is its own lane; every reply lands in the review queue.

```text
mentions tab or post url -> browser fetch -> reply target -> optional Goldfish memory -> one candidate draft -> human approval (or the capped lane approval) -> post job
```

- `GET /replies/mentions` scans the account's X notifications/mentions tab (48 hour window, promoted posts dropped, dedupe by status URL) and annotates each mention with `drafted` and `posted` flags.
- `POST /replies/mentions/scan-and-draft` (all fresh mentions, capped at 10 drafts per call), `POST /replies/mentions/draft` (chosen URLs), and `POST /replies/from-url` (a single tweet URL) all create reply drafts through the standard draft pipeline. Dedupe is done against existing drafts and post history, normalizing `twitter.com` and `x.com` links, so skipped items return a reason (`drafted`, `posted`, `unavailable`, `promoted`) instead of duplicates.
- Goldfish memory: before drafting, `@zyquor/adapters` resolves the author and topic against the user's local Goldfish MCP (wiki facts plus recent activity, 10 minute TTL cache with a 60 second negative cache). Matched material renders into the generation prompt inside `<personal-memory>`, capped at 1600 characters. Memory is additive context only and never fails a draft when unavailable (`disabled`, `empty`, `unavailable` reasons). The per-account toggle is the style rule `rules.replyMemory` (default on); a request's `useMemory` field overrides it.
- Worker auto-draft (`ZYQUOR_MENTIONS_AUTO_DRAFT=1`, `ZYQUOR_MENTIONS_ACCOUNTS`, `ZYQUOR_MENTIONS_INTERVAL_MS`, default 15 minutes) calls scan-and-draft on a timer; it only drafts.
- Worker auto-approve (stage 2, `ZYQUOR_MENTIONS_AUTO_APPROVE=1`, same accounts/interval; takes precedence over auto-draft when both are set) calls `POST /replies/mentions/scan-and-auto-approve`. The lane drafts fresh mentions with wiki-only memory (activity excerpts from email/meetings are never fetched or injected, `maxMemories: 0`) and may approve the top candidate only when it clears the quality floor (`passesTweetQualityFloor`), within a daily cap `ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP` (default 3, 0 disables, clamped 0..50) counted from same-local-day approvals of drafts marked `metadata.autoApproved`. Approval mirrors the human route (post-processing, `features`, `autoApproved: true`, `approveDraft` with `mode: "review_required"`), so the output is an ordinary queued post job; actual posting remains gated by the worker/browser flags, daily limits, and quiet hours. Anything else stays in the review queue with a `held` reason (`quality_below_floor`, `daily_cap_reached`, `draft_failed`, `approve_failed`).
- `scripts/poll-x-mentions.mjs` is a thin cron shim over the same API (`DRY_RUN=1` lists the scan; otherwise it scan-and-drafts and).

## Package Boundaries

These boundaries are preserved 1:1 in the Rust workspace as one crate each; the TypeScript package names below map to `zyquor-core`, `zyquor-accounts`, `zyquor-adapters`, `zyquor-automation`, `zyquor-generation`, `zyquor-storage`, and `zyquor-browser`.

- `@zyquor/core`: domain constants, validation schemas, post-history analysis, shared types.
- `@zyquor/accounts`: account config and dedicated-profile safety checks.
- `@zyquor/adapters`: live source adapters, aggregation, source health, optional Crawl4AI client.
- `@zyquor/automation`: source-packet context cleanup, ingest selection, draft-from-source flow.
- `@zyquor/generation`: provider clients, prompts, parsing, tweet post-processing.
- `@zyquor/storage`: SQLite/JSON/memory repositories and persistence mappers.
- `@zyquor/browser`: Playwright/CDP compose, prepare, post, and verification flow.
- `apps/api`: Fastify API and local orchestration.
- `apps/worker`: background polling for async ingest and due jobs.
- `apps/web`: local operational UI.

## Runtime Rules

- Browser posting is controlled by `ZYQUOR_ENABLE_BROWSER_POST=1`.
- Real browser prepare is controlled by `ZYQUOR_ENABLE_BROWSER_PREPARE=1`.
- Dedicated profile paths must stay under `profiles/`.
- Failed external post jobs are not auto-retried; a failed click may still have reached X.
- Source packets can produce up to two posts per account.
- Post history stores source metadata so posted text can be traced back to packet/source/tweet type.
- Aggregated source health cools down upstreams that fail or return no items repeatedly.
- Automated ingest and topic search reject undated sources and sources older than 48 hours.
- Mention auto-draft only creates reply drafts; the review queue remains the gate and nothing auto-posts from it.
- Agents drive Zyquor through the HTTP API only (see `skills/zyquor/SKILL.md`): posting and approving require an explicit user ask in that session.

## Source Health

The aggregated news adapter tracks per-upstream:

- last success time
- last failure time
- last item count
- last error
- consecutive failures
- cooldown expiration

After repeated empty/failing runs, that upstream is skipped briefly. This affects execution by keeping ingest cycles focused on sources currently returning data.

## Generation Boundary

Only `@zyquor/generation` knows provider wire formats. API selects provider from environment or saved config. UI reads and updates `/generation`; browser code never calls LLM APIs.

Supported providers:

- `command-code`: authenticated local Command Code CLI in non-interactive plan mode; default model `gpt-5.6-luna`.
- `codex`: authenticated Codex CLI in ephemeral, read-only, non-interactive mode; default model `gpt-5.6-luna` with high reasoning.
- `gemini`: Google Gemini `models/{model}:generateContent`.
- `ollama`: local `/api/generate`.
