# Architecture Notes

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

## Package Boundaries

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
- `openrouter`: OpenRouter chat completions.
- `gemini`: Google Gemini `models/{model}:generateContent`.
- `ollama`: local `/api/generate`.
