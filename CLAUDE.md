# CLAUDE.md

Guidance for agents working in this repository. Favor caution, small changes, and verifiable progress.

## Project Context

Zyquor is a local-first X posting assistant. Current flow:

```
idea/source -> generated draft -> review/edit or autopost approval -> prepare/post -> history
```

Three creation lanes: `single` (one idea → candidates → approve), `batch` (multiple ideas → multiple jobs, optional schedule spacing), `yolo` (one idea → one candidate → `autopost` immediately).

Automated lane: deterministic source ingestion → compact source packet → one generated draft → approved autopost job. LLM never browses, scrapes, schedules, ranks, or decides whether to post.

Draft generation is a single LLM call that writes candidates with all anti-slop guidance (voice, punctuation, style contract, banned phrases, source boundary) carried in the system + user prompt, retried once with a simpler line prompt only when the output cannot be parsed. `scoreTweetQuality` in `packages/generation/src/quality.ts` is a deterministic floor (`ZYQUOR_QUALITY_MIN`, default 7) against recaps and slop, not a ranker. There is no separate LLM judge in the pipeline. Measure prompt/pipeline changes with `node scripts/tweet-eval.mjs`.

Tweet types: `feed_observation`, `news_context`, `useful_info`, `guide`, `lesson`, `tool`, `opinion`, `reply`, `hiring`, `article_summary`, `narrative_history`.

Controlled posting only behind env flags. Multi-account UI, Tauri, and E2E tests are future work. Reply drafting shipped (plan 007-C).

## Architecture

- `apps/web`: Vite React UI.
- `apps/api`: Fastify API.
- `apps/worker`: background worker for due jobs.
- `packages/core`: domain types, Zod schemas.
- `packages/adapters`: source adapters, aggregation, source health.
- `packages/automation`: ingest and source-packet drafting.
- `packages/generation`: command-code/OpenRouter/Ollama/Gemini providers (no mock provider; tests inject providers via buildApp options).
- `packages/storage`: SQLite + JSON fallback repositories.
- `packages/browser`: Playwright prepare/post flow.
- `packages/accounts`: account config helpers.

Persistence: SQLite via `node:sqlite`, fallback JSON at `data/app.json`.

## Hard Constraints

- Use TypeScript.
- Use Playwright for browser automation.
- Dedicated persistent Chrome profiles per X account under `profiles/`.
- Never automate user's everyday Chrome profile.
- Do not use browser-use as production engine.
- Do not automate follows, likes, reposts, DMs, or engagement loops.
- No stealth, anti-detection, proxy rotation, CAPTCHA bypass.
- Keep Rust out of browser automation core.
- Final post action explicit and logged.
- LLM only writes candidate text; never browses, schedules, ranks, or decides to post.
- Failed external post jobs are not auto-retried because a failed browser action may still have reached X.

## Working Rules

1. State assumptions before coding if request is ambiguous.
2. Keep changes small and tied to the requested goal.
3. Prefer explicit state machines and typed schemas over loose statuses.
4. Keep browser automation isolated in `packages/browser`.
5. Keep generation outside UI and browser packages.
6. Keep account profile mapping explicit and inspectable.
7. Store failure artifacts and attempt state; do not hide browser failures in console logs only.
8. Do not refactor unrelated code while implementing a feature.
9. Add or update focused tests for validation, state transitions, repositories, and API workflows.
10. Run verification when dependencies/tooling are available; report exact blockers when they are not.

## API Routes

### Drafts
- `POST /drafts` — generate candidates from idea
- `GET /drafts/:id` — get draft with candidates
- `POST /drafts/:id/select` — select candidate, optionally edit text
- `POST /drafts/:id/approve` — approve with optional mode/scheduledFor → creates job. Optional `screened:true` turns on the server-side agent screen: rejects 409 with `Approval screen failed: ...` reasons when text fails `isCleanTweetText`, `passesTweetQualityFloor` (deterministic score < `qualityMinimum()`), or raw length <= 279 fails. Agents must always send it; humans omit it to override by judgment.

### Replies (reply lane, drafts only: nothing here posts)
- `GET /replies/feed?accountId=`: scan the X home feed for reply targets
- `POST /replies/from-url`: fetch one post URL and create a reply draft (optional `useMemory` override; optional `count` 1..50 best-of-N with bounded top-up passes for large pools; also captures up to 6 existing replies under the target into `metadata.sourceReplies` and `replyContext.otherReplies` with a do-not-repeat instruction in the prompt)
- `GET /replies/mentions?accountId=`: fresh (48h) mentions with drafted/posted flags
- `POST /replies/mentions/draft`: draft replies for chosen mention URLs (body `{mentions:[{url}]}`)
- `POST /replies/mentions/scan-and-draft`: scan and draft all fresh undrafted mentions (cap 10 per call)
- `POST /replies/mentions/scan-and-auto-approve`: capped auto-approve lane. Drafts fresh mentions with wiki-only memory (`maxMemories: 0`, activity excerpts never injected), then approves only when the top candidate clears `passesTweetQualityFloor`, within `ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP` (default 3, 0 disables, clamped 0..50) counted from same-local-day approvals of `autoApproved` drafts. Approval mirrors the human route: `tracePostProcessTweetText("mentions-auto-approve", ...)`, `features` metadata, `metadata.autoApproved: true`, then `approveDraft({mode: "review_required"})`, so a normal queued post job is created and posting stays gated by worker/browser flags, limits, and quiet hours. Held drafts (quality, cap, failures) stay in the review queue; response: `{scanned, created, approved, held, skipped, adsSkipped, dailyCap, remainingToday}`.
- `GET /replies/drafts?accountId=`: reply drafts awaiting review

Reply drafts carry `metadata.memory` (Goldfish terms/wiki/activity titles) and the response includes a `memory` summary (`used` plus counts, or reason `disabled|empty|unavailable`). Memory rendering is capped at 1600 chars inside the `<personal-memory>` prompt block. The goldfish context cache keys include `maxWiki`/`maxMemories`, so wiki-only lane lookups never hit a cached bundle with activity memories, and a zero limit skips the corresponding Goldfish RPC entirely.

### Batch
- `POST /draft-batches` — multiple jobs from ideas, optional schedule spacing

### Jobs
- `GET /jobs?accountId=` — list jobs filtered by account
- `POST /jobs/:id/prepare` — dry-run or real browser prepare
- `POST /jobs/:id/post` — explicit post click (requires `ZYQUOR_ENABLE_BROWSER_POST=1`)
- `POST /jobs/:id/retry` — verify-then-retry. Scans the target thread for the account's own reply; if the thread will not render, falls back to the account's `/with_replies` timeline. Marks the job posted when either scan finds it, otherwise re-arms `failed -> approved` and reposts through the fully gated path. Returns 409 only when both scans fail. Use only on an explicit human ask.
- `POST /jobs/post-ready` — queue all ready jobs (shuffled, sequential)
- `DELETE /jobs/:id` — delete non-running job
- `GET /jobs/:id/attempts` — attempt logs

### Source Packets
- `GET /source-packets?accountId=` — list packets
- `POST /source-packets` — create packet
- `POST /source-packets/:id/draft` — generate draft from packet → marks drafted
- `GET /source-packets/:id/draft` — existing draft for a packet (review)
- `POST /source-packets/:id/regenerate` — save feedback, replace draft, redraft with feedback in prompt
- `POST /source-packets/:id/feedback` — save/clear packet feedback without redrafting
- `DELETE /source-packets/:id` — delete packet and safe non-posted draft

### System Feedback (standing corrections injected into every generation)
- `GET /system-feedback?accountId=` — list
- `POST /system-feedback` — add `{accountId, text}`
- `DELETE /system-feedback/:id`

Feedback (post-level and standing) is appended to `feedback/notebook.md` in the project root (path from `feedbackDir` desktop setting; default `process.cwd()/feedback`). Coding agents should read that notebook before changing generation code or prompts.

### Ingest Configs (CRUD for automated source ingestion)
- `GET /ingest-configs?accountId=`
- `POST /ingest-configs`
- `POST /ingest-configs/default-news`
- `PATCH /ingest-configs/:id`
- `DELETE /ingest-configs/:id`
- `GET /ingest-sources`
- `POST /ingest-run`
- `POST /ingest-run/async`

IngestConfig fields: `accountId`, `sourceType`, `maxPacketsPerDay`, `tweetTypeMix` (Record<TweetType, number>), `scheduleWindowStart` (HH:MM), `scheduleWindowEnd` (HH:MM), `enabled`.

### Style Profiles
- `GET /style-profiles/:id`
- `PATCH /style-profiles/:id`: update tone/rules/bannedPhrases/systemPromptExtra; `rules.replyMemory` (default on) grounds replies in Goldfish memory

### Generation Config
- `GET /generation` — current provider/model
- `PATCH /generation` — change provider/model at runtime

### Browser
- `GET /browser/x-session?accountId=` — check X login state

### Accounts
- `GET /accounts`
- `PATCH /accounts/:id`

### History
- `GET /history`
- `GET /history/analysis?accountId=&sinceHours=`

### Worker
- `GET /worker/status`
- `POST /worker/heartbeat`

### System (desktop control plane)
- `GET /system/status`
- `POST /system/posting` — toggle prepare/post flags live
- `POST /system/ingest/cancel`
- `GET /system/logs`
- `POST /system/worker/pause`
- `POST /system/chrome/close`
- `POST /system/stop-all`
- `POST /system/quit`, `POST /system/restart` (desktop only)

## Web UI State

Mode derived from UI inputs:
- Schedule set → `scheduled`
- No schedule + Yolo → `autopost`
- No schedule + no Yolo → `prepare_only`

Controls: idea composer (single/batch), tweet type, Yolo autopost toggle, schedule datetime, batch spacing, candidates/editor, prompt/style panel (tone/objective/banned/system), source packets panel, jobs panel.

Removed from UI: noisy account/profile/daily-limit editing. Account config remains in storage/API.

## Current Runtime

```
./zyquor
./zyquor check
./zyquor post <jobId>

# Electron desktop app (Windows)
pnpm dev:desktop
pnpm smoke:desktop
pnpm dist:desktop
```

- Chrome CDP on this machine: `http://172.31.96.1:9223` (Windows portproxy to `127.0.0.1:9222`), profile `profiles/reply-loop-test`, headless via `ZYQUOR_BROWSER_HEADLESS=1`
- API: `http://127.0.0.1:3001` on this machine (3000 is occupied by an unrelated app; the server falls back to 3001 only when `ZYQUOR_API_PORT` is unset)
- Web: `http://127.0.0.1:5173/`
- Worker polls due jobs every 5s
- Electron desktop app: `apps/desktop/` — Electron 37, tray-resident, runs API/worker in-process. Data root via `ZYQUOR_DATA_ROOT` (defaults to Electron `userData`). Settings kept as `settings.json` in data root instead of `.env`. Logs to `<dataRoot>/logs/main.log` (batched writes, rotates to a single `main.log.1` backup at 5 MB, checked on write and at startup). Entry points: `src/main.ts` (main process), `src/preload.ts` (context bridge), `src/chrome.ts` (CDP launch), `src/settings.ts` (JSON config), `src/log.ts` (file logging).
- Desktop settings worth knowing: `headless` maps to `ZYQUOR_BROWSER_HEADLESS` (default off, surfaced as a checkbox in the settings panel), and `cdpPort` maps to `ZYQUOR_BROWSER_CDP_URL`. The launcher resolves per-account ports through `perProfileCdpUrl` from `@zyquor/core`, the same helper the API uses, so the desktop and the posting path always agree on the port. Do not reimplement that mapping in either place.
- Desktop window: `contextIsolation`, `sandbox`, and `setWindowOpenHandler` are on, and `will-navigate` sends external links to the system browser. Never remove those handlers; without them a link in the UI opens a bare Electron window with no address bar.

Env flags: `ZYQUOR_ENABLE_BROWSER_PREPARE=0`, `ZYQUOR_ENABLE_BROWSER_POST=0` (disabled by default for safety), `ZYQUOR_LLM_PROVIDER=command-code|opencode|openrouter|gemini|ollama|auto`. `ZYQUOR_REVISION_PASS=1` adds a cut-only second-pass revision (opencode only): it removes vagueness and unsupported claims from the first-pass drafts, never adds material, and can never lower a candidate; it doubles generation latency and is off by default.
Source smoke: `pnpm smoke:adapters`. Product Hunt is optional without `ZYQUOR_PRODUCTHUNT_API_TOKEN`.

### pnpm Setup
Do not use the Hermes-installed pnpm. Install globally via npm:
```bash
npm install -g pnpm
ln -sf $(npm root -g)/pnpm/bin/pnpm.cjs ~/.local/bin/pnpm
```

### Generation Provider Resolution
- Provider is resolved in order: saved `data/generation.json` > `.env` > `process.env`.
- Set `ZYQUOR_LLM_PROVIDER` explicitly to `command-code` or `opencode`; the desktop setup does not use `auto` or OpenRouter.
- Shell env vars take precedence over `.env`; the dotenv loader skips already-set vars.
- Preferred provider is `opencode` with model `opencode/deepseek-v4.1-flash-free` (high reasoning). The `opencode` provider drives the opencode CLI (`opencode run --variant high`) and is the primary generation path; other providers remain available but are not used by default. Command Code remains available with model `gpt-5.6-luna`. CLI paths use `ZYQUOR_COMMAND_CODE_PATH` and `ZYQUOR_OPENCODE_PATH`; the opencode model and reasoning variant come from `ZYQUOR_OPENCODE_MODEL` and `ZYQUOR_OPENCODE_VARIANT`. All CLI providers use the single generation flow. OpenRouter is not used by the desktop setup.

### X Render Failures Are Not Logouts

- Symptom: X loads its shell but stays on the `Loading…` placeholder forever. `document.body.innerText` is empty, no console or page errors, while `/i/api/1.1/graphql/viewer_context.json`, `/1.1/account/settings.json`, and `HomeTimeline` all return 200. The session is valid; the client just stopped painting.
- `assertNotLoginPage` used to treat "authenticated UI not visible" as "logged out". It now calls `readLoggedInHandle` first: if the credentials endpoint returns a handle, it throws a distinct render error (`X did not render the authenticated shell ... not a logout ... do not clear cookies`). Only a login URL, visible login inputs, or a failed credentials check produce the "not logged in" message.
- Never clear x.com site data, cookies, or force a re-login on that error. Check the credentials endpoint and the rendered DOM first. Clearing site data deletes the real session and turns a render bug into a forced login.
- Recovery order: relaunch the dedicated Chrome profile, then retry. If the same profile still will not render, move to a fresh profile and log in once. The old `personal-main` profile was corrupt at profile level (survived cookie, storage, IndexedDB, service worker, cache, GPU cache, and extension clears); the account now uses `profiles/reply-loop-test`.
- Port topology on this machine: the API talks to `http://172.31.96.1:9223`, a Windows `netsh` portproxy to `127.0.0.1:9222`. Chrome binds 9222 to loopback only, so direct `172.31.96.1:9222` fails while 9223 works. Use the portproxy URL.

### Posting Chrome CDP Ports

- `perProfileCdpUrl` derives each profile's CDP port from the base URL. Profiles named in `ZYQUOR_BROWSER_CDP_BASE_PROFILES` (comma separated, default `personal-main`) stay on the base port; `willainotice` gets base+1; anything else gets a stable hash offset.
- The Windows portproxy here only forwards 9223 to 9222, so a profile that hashes to another offset resolves to a dead port. Posting then fails with `Chrome CDP is unavailable at http://172.31.96.1:9224`. Add the active profile to `ZYQUOR_BROWSER_CDP_BASE_PROFILES`; do not add more portproxy rules for every profile.
- Settings change `cdpPort` rewrites the base URL, not the offsets. The env list is the supported way to pin a profile to the base port.

### Headless Posting Chrome

- `ZYQUOR_BROWSER_HEADLESS=1` makes the posting Chrome run `--headless=new` on the same profile and CDP port, with no visible window. `ensureBrowserCdp` honours it, so auto-launch after a CDP loss does not reopen one.
- Restart scripts on Windows: `C:\Users\asus\zyquor-profiles\relaunch-fresh.ps1` (headless, canonical) and `relaunch-headed.ps1` (visible, only for debugging a page that will not render). `launch-headless.ps1` is a wrapper for the canonical script.
- Verified on 2026-10-28: headless logs in as `@haroon0x`, renders the feed, fills the composer, and the feed scan returns rows. The UA string contains `HeadlessChrome`, and X still serves the full client.
- Debugging headless means screenshots (`apps/api/data/artifacts`), not looking at a window. If X stops painting only in headless, switch to `relaunch-headed.ps1` and compare before changing any code.

### Browser Job Failure Modes

- Chrome raises a `beforeunload` dialog when a page navigates or closes with unsent composer text. Playwright's internal auto-dismiss races Chrome and throws `No dialog is showing` from an unhandled promise, which used to kill the API mid-post. `openPersistentContext` now installs dialog dismissers on every page, and `apps/api/src/server.ts` logs unhandled rejections instead of exiting.
- `resolvePostedPermalink` matches the posted reply by the account handle and the submitted text. Without that, a reply stores the parent tweet URL as its permalink, because the page stays on the parent thread after a reply posts.
- A failed post can leave the composer holding the text. Clear it before the next attempt (`Control+A`, `Backspace`) or the next navigation triggers that dialog.

### Posts-Only Reply Loop

`scripts/reply-loop.mjs` is the unattended posts-only lane. It does not touch mentions. It discovers targets from `GET /replies/feed` first (people the owner follows), then falls back to X search through the logged-in Chrome when the feed is thin, already seen, or rejected. It drafts best-of-N through `POST /replies/from-url`, applies a deterministic slop screen, then approves with `screened:true` and posts through the normal gated job path. Every rejection is appended to `apps/api/data/reply-loop.jsonl` with a reason, which is the input for tightening prompts or filters.

Screen reasons, and why each exists:

- `invented_number`: a digit in the reply that does not appear in the target.
- `invented_experience`: claims of having used, run, shipped, or deployed the thing. First person opinion (`my pick is`, `I'd split this`) is allowed, fabricated usage is not.
- `lowercase_opener`: the account voice is sentence case, so an all-lowercase opener reads like a different person.
- `invented_point`: `Point 2` when the target is not a numbered list.
- Formula contrasts, advice openers, and the usual slop words.
- Quality floor, which must match `replyQualityMinimum` in `@zyquor/generation` (5). The post scorer was calibrated on 220 to 480 character posts and a one-line reply rarely reaches the post floor while still being clean.

```bash
node scripts/reply-loop.mjs --once --dry   # discover, draft, report; no approval
node scripts/reply-loop.mjs --once         # one cycle, may post
node scripts/reply-loop.mjs                # every 30 min, max 1 post per cycle
```

Env: `ZYQUOR_REPLY_LOOP_QUERIES`, `ZYQUOR_REPLY_LOOP_INTERVAL_MS` (default 30 min), `ZYQUOR_REPLY_LOOP_MAX_POSTS` (default 1), `ZYQUOR_REPLY_LOOP_MAX_PER_DAY` (default 20, rolling 24 hours counted from `/performance`), `ZYQUOR_REPLY_LOOP_MIN_QUALITY` (default 5), `ZYQUOR_REPLY_LOOP_CANDIDATES` (default 4). Starts a posting lane, so run it only on an explicit ask.

### Original Post Loop

`scripts/post-loop.mjs` is the standalone post lane, separate from replies. It walks a rotating topic bank in least-recently-used order (`TOPIC_BANK` near the top of the file, safe to edit), creates a draft through `POST /drafts`, generates candidates through `POST /drafts/:id/generate`, screens them, then selects, approves with `screened:true`, and posts through `POST /jobs/:id/post`. It posts about 5 originals a day inside a 09:00 to 22:00 account-local window, with a full interval between originals so a late start cannot burn the day's quota in one burst.

The cap and spacing come from `GET /performance` history, not local counters, so a restart cannot exceed the limit. Only rows with `tweetType !== "reply"` count as originals. Decisions and rejections go to `apps/api/data/post-loop.jsonl`; rotation state and the recent-text de-dupe list live in `apps/api/data/post-loop-state.json`.

Screen reasons: `too_short` (under 180 chars), `too_long` (over 620), `lowercase_opener`, `question_bait`, `hashtag_or_mention`, `has_link`, `dash` (em or en dash), `slop_word`, `formula_contrast`, `invented_experience`, `invented_stat`, and `repeat`.

```bash
node scripts/post-loop.mjs --once --dry    # draft and report; no approval
node scripts/post-loop.mjs --once          # post now if under the daily cap
node scripts/post-loop.mjs                 # run forever
node scripts/post-loop.mjs --once --force  # ignore the daily cap
```

Env: `ZYQUOR_POST_ACCOUNT_ID` (default `account_personal`), `ZYQUOR_POST_LOOP_PER_DAY` (default 5), `ZYQUOR_POST_LOOP_START_HOUR` (default 9), `ZYQUOR_POST_LOOP_END_HOUR` (default 22), `ZYQUOR_POST_LOOP_UTC_OFFSET_MIN` (default 330 for IST), `ZYQUOR_POST_LOOP_MIN_QUALITY` (default 7), `ZYQUOR_POST_LOOP_CANDIDATES` (default 4), `ZYQUOR_POST_LOOP_MIN_GAP_MIN` (default 20). Also starts a posting lane.

### Generation Providers

Opencode is the only configured provider: `ZYQUOR_LLM_PROVIDER=opencode` with `opencode/deepseek-v4.1-flash-free#high`. The free tier has a usage cap that is shared across every `opencode/*` free model, so when it is exhausted every lane fails with `Free usage limit reached`. That is an account quota, not a code fault. `command-code` needs paid credits. A Codex provider was written and tested on 2026-10-28 and then removed because Codex is not available to this machine's owner. Freebuff was evaluated and rejected as a generation provider: the CLI is a full TUI with no `--print` or non-interactive mode, it ignores a piped prompt, and it exits without producing an answer, so it cannot be spawned per prompt the way `opencode run` and `command-code --print` can.

### Browser Automation Caveats

- Playwright bundled Chromium (`playwright install chromium`) fails on Ubuntu 26.04+ — it's unsupported on newer distros.
- On such systems, install system Chrome and set `ZYQUOR_BROWSER_CHANNEL=chrome`:
  ```bash
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
  sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list'
  sudo apt update && sudo apt install google-chrome-stable
  ```

## Latest Work (2026-10-28)

- Added the original post lane `scripts/post-loop.mjs` with `pnpm post:loop`: rotating topic bank, 5 posts a day, 09:00 to 22:00 IST window, interval spacing, and a cap counted from server history.
- Reply screen corrected after auditing 54 cycles: the floor now matches `replyQualityMinimum` (5 instead of a separate 6), `first_person_review` became `invented_experience` so opinions pass and fabricated usage does not, plus new `lowercase_opener` and `invented_point` rejections.
- Reply cadence reduced to 30 minutes with a rolling 24 hour cap of 20, and the sleep is now interruptible so a restart does not wait out the full interval.
- Post prompt now demands sentence case and refuses to return the idea itself as a candidate. Reply prompt now names the concrete thing, bans `Point 2` on unnumbered targets, and keeps sentence case.
- A Codex provider was written, tested, and then removed the same day because Codex is not available. Opencode is the only configured provider.
- Freebuff evaluated and rejected as a provider: TUI only, no non-interactive flag, piped prompt ignored, exits without an answer.

- Posting resolved to the wrong CDP port: `perProfileCdpUrl` hashed `profiles/reply-loop-test` to base+1 (9224), which the Windows portproxy does not forward. Added `ZYQUOR_BROWSER_CDP_BASE_PROFILES` (default `personal-main`, set to `personal-main,reply-loop-test` here), routed `routes/browser.ts` through the shared helper, and added unit tests for the offset rules.
- Fixed the API crash mid-post: a leftover unsent composer triggered a `beforeunload` dialog and Playwright's auto-dismiss threw `No dialog is showing` from an unhandled promise. Dialog dismissers now attach to every page in `openPersistentContext`, and `server.ts` logs unhandled rejections instead of exiting.
- Fixed `resolvePostedPermalink`: replies now record their own status URL instead of the parent tweet. Verified on the first runner post of the day.
- `scripts/reply-loop.mjs` saves state after every decision, so a kill or restart no longer loses the seen list. Discovery is sequential, home feed first, then search, because the feed scan owns and closes its browser context.
- Loop posted through the fresh profile: https://x.com/haroon0x/status/2115336263507349620 (reply to `jatinkrmalik`).
- Discovery order flipped to home feed first, search as fallback, so replies go to people the owner follows when the feed has eligible posts.
- Posting Chrome now runs headless (`--headless=new`) behind `ZYQUOR_BROWSER_HEADLESS=1`. Verified login, feed render, composer fill, and the feed API scan with the window closed.

## Latest Work (2026-10-27)

- `scripts/reply-loop.mjs`: posts-only reply runner. Search + feed discovery, best-of-N draft, deterministic slop screen, gated approve (`screened:true`) and post. Rejections go to `apps/api/data/reply-loop.jsonl` so prompt rules are added only when a reason repeats.
- `assertNotLoginPage` no longer reports a hung X shell as a logout. It reads the credentials endpoint first and raises a distinct "did not render" error when the session is valid. This was the root cause of the destructive site-data clear that forced a re-login. Never clear cookies on that message.
- Reply prompt slimmed: reply instruction block 15 paragraphs to 5, full reply prompt payload 10,291 to 7,887 chars. Comments under a target are framed as read-only context; closed topics are excluded.
- Default generation model moved to `opencode/deepseek-v4.1-flash-free` (variant high).
- Account `account_personal` now uses `profiles/reply-loop-test`; the old `personal-main` profile was corrupt at profile level (hung on X's `Loading…` through cookie, storage, IndexedDB, service worker, cache, GPU cache, and extension clears).

## Latest Work (2026-10-26)

- Replies-first flow shipped end to end from the frozen spec `tasks/replies-first-goldfish.md`: `GET /replies/mentions`, `POST /replies/mentions/draft`, `POST /replies/mentions/scan-and-draft`, plus per-reply Goldfish memory grounding (style rule `rules.replyMemory`, request `useMemory` override, 10 min TTL cache in `@zyquor/adapters` via `fetchGoldfishReplyContext`). Every mention draft lands in the review queue; nothing auto-posts.
- Mentions auto-draft is optional and off by default: worker env flags `ZYQUOR_MENTIONS_AUTO_DRAFT=1` + `ZYQUOR_MENTIONS_ACCOUNTS` (cadence `ZYQUOR_MENTIONS_INTERVAL_MS`, default 15 min) call the same scan-and-draft API per account on a timer. `scripts/poll-x-mentions.mjs` is now a thin API shim (`DRY_RUN=1` lists the scan; real run scan-and-drafts and enqueues external mention links for the demo-checker).
- Web: Replies is now the default view with a mentions panel (select fresh items, draft selected or one by one, Drafted/Posted pills, 48h window) and a "Ground replies with Goldfish memory" toggle in the Style panel (stored as `rules.replyMemory`).
- New portable agent skill `skills/zyquor/SKILL.md` (curl-only, works for any agent CLI, no opencode-specific tooling; installed locally at `~/.agents/skills/zyquor` and `~/.config/opencode/skill/zyquor`). It documents the HTTP API recipes and hard safety rules: review queue is the gate, posting needs an explicit ask, failed jobs are never auto-retried, memory stays private.
- Fixed a storage init regression from the perf pass: the partial index on `post_history.text_hash` is now created after the column migration, so fresh SQLite databases initialize cleanly again (this had broken every in-memory repository, including all API tests).

## Latest Work (2026-08-03)

- Two-level feedback: per-post feedback stored on the source packet, injected into that packet's redraft, regenerates the post for review (`/source-packets/:id/regenerate`); per-account standing feedback injected into every generation's system prompt (`/system-feedback`). Both append entries to `feedback/notebook.md` (repo root) for coding agents to act on.
- Source packets panel gained Review (open existing draft) and Regenerate (feedback + redraft) actions; Style panel gained a system feedback list.

## Latest Work (2026-07-21)

- Reader-critic quality pipeline in the command-code provider plus `scripts/tweet-eval.mjs` for measuring it.
- Ingest grounding: fresh-source filter (48h), host caps, topic-overlap and thin-context skips.
- Desktop control plane: `/system/*` routes (status, posting toggle, logs, worker pause, chrome close, stop-all, quit, restart) and a System view in the web UI.
- Source health cools down failing/empty aggregated upstreams; post-history analysis and source metadata tracing exist.

## Next Steps

Shipped since the last update (plans/006, plans/007): Electron desktop app,
api/web file splits, worker durability + status panel, source routing/quality,
reply drafting end-to-end, web design pass, safety fixes (manual review never
autoposts by default, masked keys can't clobber real ones, stealth flag
removed, posting disabled by default everywhere).

**Remaining**: split large generation/adapters files; account creation flow
(only GET/PATCH exist); schedule-clearing via PATCH /jobs/:id; shuffled
post-all (docs promised, code is chronological); surface quality-gate-failed
drafts in UI; app icon + Windows code signing; OS keychain for API keys;
auto-update.

**Deferred**: multi-account UI, voice input, E2E test suite.

## Common Commands

```bash
pnpm bootstrap
pnpm smoke
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm check
pnpm test
pnpm build
```
----
# Delegation Rules

You are the **coordinator**: design, decide, review, land. Delegate hands-on execution and well-scoped research to **executor subagents** (Agent tool, `model: sonnet') or to the command-code CLI running DeepSeek V4 Pro.

## Role check first

- If your prompt starts with `ROLE: EXECUTOR` — or you were spawned by another agent at all — you are an **executor**: ignore the rest of this file, do the work order yourself, **never spawn subagents**. If blocked or the order is ambiguous, report back instead of delegating.
- Coordinator: start every executor prompt with `ROLE: EXECUTOR — do the work yourself; do not spawn subagents.`

## Delegate (default for hands-on work)

- Implementation from a frozen spec; refactors; migrations
- Bug fixes, CI/lint/type failures, tests, dependency bumps, tooling
- Read-heavy exploration — fan out parallel executors, each returns a distilled summary
- Git mechanics (rebase, conflicts, merge workflow) — mechanics only, after the coordinator decides to land

## Keep in the coordinator

- Design, architecture, naming, UX judgment; tasks where writing the spec IS the work
- Tiny edits (~<20 lines) — delegation overhead loses
- Session tools (MCP, secrets), releases/publishes/version bumps
- The land decision, pre-land gates (review clean, CI green, proof), and review of all executor output — never delegated, never skipped

## How

- Complex work: freeze the spec as a md file in `/tasks` first; executor prompts reference it. Small work: full work order inline in the prompt, no spec file.
- Executor prompts are self-contained (context, constraints, expected output) — subagents don't see your conversation.
- Review output before accepting; re-delegate failures with the error context included.
- Heuristic: prompt reads as a work order → delegate; writing it forces decisions → coordinator.
