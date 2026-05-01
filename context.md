# Zyquor Project Context Handoff

Date written: 2026-05-01

This file captures the work requested and implemented during the current agent session so a future agent can continue with fresh memory.

## User Goals From Conversation

The user wanted the project made working end-to-end, with special focus on:

- Get the local Zyquor app running.
- Resolve current project issues and bugs.
- Make the automatic worker reliable.
- Improve the system prompt, context engineering, and LLM harness.
- Add more ingest coverage, but not as separate UI "categories"; specifically expand the ingest keyword/topic logic such as `PREFERRED_NEWS_KEYWORDS`.
- Reduce restrictions on eligible source items so useful items are not dropped just because they do not match a narrow keyword list.
- Add more data/source coverage, including science, research, economy, markets, policy, AI, technology, startups, and similar areas.
- Add frontend controls to delete generated drafts from source packets.
- Add frontend/backend option to delete all sources.
- Automatically remove source packets once their generated drafts are posted.
- Let tweets include the source URL only when the LLM thinks it improves credibility/context/usefulness, not always.
- Update the system instructions/prompt so conditional source-link behavior is explicit.
- Make the frontend clearly show which model is being used live in realtime.
- Add OpenRouter model `inclusionai/ling-2.6-1t:free`.
- Ensure OpenRouter model `minimax/minimax-m2.5:free` is present.
- Add provider/model selection in frontend:
  - If provider is OpenRouter, show OpenRouter models.
  - If provider is Gemini, show Gemini models.
  - If provider is Ollama, show Ollama models.
  - Allow model selection via dropdown, with custom model input still available.
- Restart the system using OpenRouter model `inclusionai/ling-2.6-1t:free`.
- Update daily max post/ingest limit to 300.
- Create this `context.md` file with all tasks and discussion.
- Run `git add .` and push changes.

The user also invoked caveman style earlier, so final/status messages were kept concise.

## Runtime State

The app was started with:

```bash
./zyquor
```

Known runtime status from `./zyquor check` before the final restart:

- Web: `http://127.0.0.1:5173/`
- API: `http://127.0.0.1:3001`
- X session: logged in
- Generation: `openrouter inclusionai/ling-2.6-1t:free`

The local X/Chrome profile is open via CDP on port 9222. The app process was seen running after the last restart:

- `node /home/g/Documents/zyquor/scripts/zyquor.mjs`
- API: `node dist/server.js`
- Web: Vite on `127.0.0.1:5173`
- Worker: `ZYQUOR_RUN_WORKER=1 node dist/index.js`
- Chrome: `/opt/google/chrome/chrome ... --remote-debugging-port=9222 ... https://x.com/home`

The saved generation config is in `.zyquor/generation.json`:

```json
{
  "provider": "openrouter",
  "model": "inclusionai/ling-2.6-1t:free"
}
```

The local SQLite account row was updated directly so `account_personal.daily_post_limit = 300` in `data/app.sqlite`.

## Important Behavioral Notes

During restarts, the worker processed existing approved/autopost jobs in the local DB. Logs showed successful `/post` requests and messages like `Prepared 4 approved job(s)` / `Prepared 1 approved job(s)`. That log wording is misleading because the worker can post jobs as well; it is not necessarily only preparing. Future agent may want to rename that log message.

OpenRouter Ling sometimes returned no clean candidates for ingest (`openrouter returned no draft candidates`). This is handled without crashing the worker, but if generation quality/format issues continue, future work should add a fallback retry/line prompt for OpenRouter similar to Ollama or improve parsing.

Browser tests remain skipped by design in the current test suite.

## Implemented: Ingest Expansion And Less Restrictive Sources

Files changed:

- `packages/automation/src/ingest.ts`
- `packages/automation/src/index.test.ts`
- `packages/adapters/src/aggregator.ts`
- `packages/adapters/src/index.test.ts`
- `apps/api/src/app.ts`

Details:

- Expanded preferred ingest/news keywords beyond narrow tech/HN topics.
- Added/boosted topics such as:
  - AI agents, AI infrastructure, LLMs, inference, GPUs, chips, datacenters.
  - Programming, software, open source, GitHub, developer tools.
  - Science, research, arXiv, papers, biotech, medicine, climate, energy.
  - Batteries, nuclear, solar, robotics, space, materials, quantum.
  - Economy, GDP, Fed, rates, inflation, jobs, markets, stocks, crypto.
  - Policy, regulation, geopolitics, India, Europe, defense, semiconductors.
  - Startups, IPOs, funding, acquisitions, business and product launches.
- Added test coverage that preferred science/battery/economy source items are prioritized over low-value/lifestyle items.
- Created/used `createAggregatedNewsAdapter`.
- Default API source adapter changed from HackerNews-only to aggregated news plus RSS.
- Reduced eligible source restrictions:
  - Renamed/expanded adapter scoring keyword list to preferred topic keywords.
  - Added `requireTopicMatch?: boolean`, default `false`.
  - Non-HN aggregated news items are no longer hard-dropped just because they do not match the preferred topic list.
  - Preferred topics now boost score instead of acting as strict gate by default.
- Added adapter regression test to ensure a TechCrunch item without a preferred keyword still passes through when `requireTopicMatch` is false.

## Implemented: Context Engineering, Prompt, And LLM Harness

Files changed:

- `packages/automation/src/context.ts`
- `packages/generation/src/harness.ts`
- `packages/generation/src/index.ts`
- `packages/generation/src/index.test.ts`
- `scripts/tweet-harness.mjs`

Details:

- `articleTweetIdea` and `sourceTweetInput` now pass `sourceType` through to the generation harness.
- `TweetSourceContext` includes `sourceType`.
- `buildSourceTweetInput` includes source type in rendered context.
- Prompt now emphasizes:
  - Concrete, concise, review-ready X drafts.
  - Useful reach/reputation, not cheap spam.
  - Broader domains: AI, tech, programming, science, research, economics, markets, geopolitics shaped by tech, policy, startups, business news.
  - Use only provided facts/source context.
  - Pick one angle per candidate, do not mash all facts together.
  - Avoid internal labels and harness wording.
  - Avoid hallucinated sources, dates, numbers, quotes, schedules, strategy.
- Added conditional source-link instruction:
  - LLM may include the source URL when it improves credibility, context, or usefulness and still fits the 280-char limit.
  - Do not force links into every candidate.
  - This was added both to system prompt and harness/source-context instructions.
- Added leak/slop rejection patterns:
  - Blocks `grounded facts`, `source context`, internal metadata wording.
  - Rejects generic phrases such as `game changer`, `unlock`, `leverage`, `synergy`, `in today's world`, `now more than ever`, `as an AI`.
- Added tweet harness cases for:
  - `science-research`
  - `economy-markets`
- Added tests for:
  - rejecting generic phrase `game changer`.
  - source type rendering.
  - source URL instruction.

Important source-link behavior:

- It is intentionally conditional. The model decides whether adding the URL improves the tweet.
- The system prompt should not require every generated candidate to include a URL.
- If future agent changes this, keep the user requirement: "add link only when LLM thinks it would be better; it should add it when useful."

## Implemented: LLM Providers And Model Dropdown

Files changed:

- `packages/core/src/index.ts`
- `packages/generation/src/index.ts`
- `packages/generation/src/index.test.ts`
- `apps/api/src/app.ts`
- `apps/api/src/app.test.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`

Details:

- Added first-class provider type `gemini` alongside `openrouter` and `ollama`.
- Added Gemini env support:
  - `ZYQUOR_GEMINI_API_KEY`
  - `ZYQUOR_GEMINI_BASE_URL`
  - `ZYQUOR_GEMINI_MODEL`
- Added `createGeminiGenerationProvider`.
  - Uses Google Generative Language API endpoint:
    `/models/{model}:generateContent?key=...`
  - Uses `systemInstruction`, JSON response mime type, temperature, max output tokens.
- Added provider-specific model option export:
  - `GENERATION_MODEL_OPTIONS`
  - `OPENROUTER_MODELS`
  - `GEMINI_MODELS`
  - `OLLAMA_MODELS`
- OpenRouter models include:
  - `nvidia/nemotron-3-super-120b-a12b:free`
  - `inclusionai/ling-2.6-1t:free`
  - `minimax/minimax-m2.5:free`
  - `tencent/hy3-preview:free`
- Gemini model dropdown includes:
  - `gemini-2.5-flash`
  - `gemini-2.5-pro`
  - `gemini-2.0-flash`
  - `gemini-1.5-flash`
- Ollama model dropdown includes:
  - `llama3.1`
  - `llama3.1:8b`
  - `qwen3:8b`
  - `qwen2.5:7b`
  - `mistral:7b`
- API `/generation` now returns:
  - current generation config
  - provider-specific model options
- API `PATCH /generation` now supports `gemini` and persists provider/model.
- Frontend model panel now:
  - Shows live realtime model prominently.
  - Shows provider dropdown.
  - Shows model dropdown filtered by selected provider.
  - Keeps a custom model text input for manual model IDs.
- Top account strip now says `Live model: Provider / model`.
- Saved runtime model was set to:
  - provider: `openrouter`
  - model: `inclusionai/ling-2.6-1t:free`

## Implemented: Source Draft Delete, Delete All Sources, Posted Cleanup

Files changed:

- `packages/storage/src/types.ts`
- `packages/storage/src/memory.ts`
- `packages/storage/src/sqlite.ts`
- `packages/storage/src/index.test.ts`
- `apps/api/src/app.ts`
- `apps/api/src/app.test.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`

Details:

- Added repository methods:
  - `deleteSourcePacket`
  - `resetSourcePacket`
  - `getDraftBySourcePacketId`
  - `deleteDraft`
- `deleteDraft` behavior:
  - Blocks deletion when associated jobs are running or posted.
  - Deletes non-posted draft plus related jobs, attempts, candidates, fingerprints.
- Added API route:
  - `DELETE /source-packets/:id/draft`
  - Deletes generated source draft and resets source packet to `new`.
  - Blocks unsafe deletion through repository rules.
- Added API route:
  - `DELETE /source-packets?accountId=...`
  - Bulk deletes all source packets for account.
  - Deletes non-posted source-linked drafts/jobs/candidates/fingerprints.
  - Preserves posted draft/history and deletes only the source-packet link.
  - Skips running/unsafe packets and returns counts/results.
- Added posted cleanup:
  - After a source-generated draft is successfully posted, the source packet link is removed automatically.
  - Draft/history audit is preserved.
- Frontend source cards now include:
  - `Draft`
  - `Delete draft` when packet status is `drafted`.
- Frontend source panel has:
  - source count
  - `Delete all` action.
- Added CSS for source actions, panel header actions, compact buttons.
- Added tests for:
  - deleting generated draft from a source packet and resetting packet.
  - deleting all source packets and removing non-posted generated drafts.
  - removing source packet links after source-generated drafts are posted.

## Implemented: Automatic Worker Robustness

Files changed:

- `apps/worker/src/index.ts`
- `apps/worker/src/index.test.ts`

Details:

- `processApprovedJobs` now wraps each due job action in its own `try/catch`.
- One failed prepare/post no longer aborts the entire worker batch.
- Returns successful processed count.
- Added regression test that worker continues processing due jobs even when one job action fails.

Remaining possible improvement:

- The worker log currently says `Prepared X approved job(s)` even when it posted autopost jobs. Future agent should rename this log to something like `Processed X approved job(s)`.

## Implemented: Daily Max 300

Files changed:

- `packages/core/src/index.ts`
- `packages/storage/src/memory.ts`
- `packages/storage/src/sqlite.ts`
- `apps/web/src/main.tsx`

Details:

- Raised ingest config `maxPacketsPerDay` schema max from 100 to 300.
- Frontend `Daily max` input now has `max="300"` instead of 20.
- New default account daily post limit changed from 1000 to 300 in memory and SQLite seed.
- Existing local SQLite account was updated directly:

```sql
UPDATE accounts SET daily_post_limit = 300 WHERE id = 'account_personal';
```

## Verification Already Run

Full test suite passed after the major implementation:

```bash
pnpm test
```

That suite built all packages and ran:

- adapters: 7 tests
- core: 7 tests
- accounts: 2 tests
- worker: 5 tests
- generation: 11 tests after Gemini/model additions
- browser: 3 skipped
- storage: 5 tests
- automation: 2 tests
- api: 21 tests
- web/voice: no tests with `passWithNoTests`

Focused checks also passed after later changes:

```bash
pnpm --filter @zyquor/generation test
pnpm --filter @zyquor/api test
pnpm --filter @zyquor/web build
pnpm --filter @zyquor/core test
pnpm --filter @zyquor/storage test
pnpm --filter @zyquor/storage build
pnpm --filter @zyquor/api build
```

After the daily max 300 change, this focused command passed:

```bash
pnpm --filter @zyquor/core test && pnpm --filter @zyquor/storage test && pnpm --filter @zyquor/web build && pnpm --filter @zyquor/api build
```

## Known Issues / Risks For Future Agent

- OpenRouter Ling model can return output that fails current strict candidate parsing/cleaning during ingest. The worker handles the failure without crashing, but ingest may produce zero drafts. Consider:
  - adding OpenRouter fallback line prompt like Ollama,
  - adding a second repair request,
  - or making JSON extraction more tolerant while preserving quality filters.
- Automated worker may post existing approved/autopost jobs during app startup. Be careful when restarting on a live logged-in X session.
- The current app has real local state in `data/app.sqlite`. Avoid deleting/resetting it unless user explicitly asks.
- Browser tests are skipped; do not claim browser automation was exhaustively tested by unit tests.
- The source-link behavior must remain conditional. Do not append source links outside the model unless the user explicitly changes the requirement.
- `context.md` was requested as future-agent memory. Keep it updated when making significant changes.

## Git Instructions From User

The user asked:

- Create/continue `context.md`.
- Add as much detail as possible from the conversation.
- `git add .`
- push.

After writing this file, the next steps are:

```bash
git status --short
git add .
git status --short
git commit -m "Complete automation ingest and model controls"
git push origin master
```

If commit fails due missing git identity, configure local identity only if acceptable or report blocker. If push fails due auth, report blocker.
