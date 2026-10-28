---
name: zyquor
description: Drive Zyquor, the user's local-first X posting and reply engine, over its HTTP API with plain curl. Use whenever the user mentions Zyquor, their accounts, mentions, reply drafts, the review queue, approving/scheduling posts, posting jobs, history, or performance stats, or asks "draft a reply to this post", "scan my mentions", "what's in the queue", or "post the next job". The review queue is the gate: nothing is ever posted without an explicit ask.
---

# Zyquor

Zyquor is the user's local-first posting and reply engine for X (Twitter). Each X account has its own Chrome profile, its own limits (daily post cap, quiet hours, spacing), and posts run concurrently per account. The per-day hard ceiling comes from `ZYQUOR_DAILY_POST_CEILING` in the repo `.env` (currently 50 flat: ceiling 50, variance band 50/50). Every post starts as a draft that a human approves. Nothing auto-posts unless the user explicitly says so.

## Runtime

- API: Fastify, default port 3000. On this machine (WSL) the API runs on port 3001 because 3000 is taken by an unrelated app. Start it with:
  `ZYQUOR_API_PORT=3001 pnpm --filter @zyquor/api dev` (from the repo root).
  Probe health on both ports before deciding on a base URL.
- Web UI: `ZYQUOR_API_URL=http://127.0.0.1:3001 pnpm --filter @zyquor/web dev`.
  The API in this repo is the source of truth for state (SQLite). All data lives locally.
- Worker: `pnpm --filter @zyquor/worker dev` drives post jobs, ingest, and performance. It needs desktop settings for browser posting (handled by the desktop app or `GET /settings`).
- Posting Chrome on this machine: CDP `http://172.31.96.1:9223`, profile `profiles/reply-loop-test`, headless via `ZYQUOR_BROWSER_HEADLESS=1`. Restart with the Windows `relaunch-fresh.ps1`; `relaunch-headed.ps1` is the visible fallback.
- Mentions auto-draft (optional, off by default): the worker calls the same scan-and-draft endpoint on a timer when `ZYQUOR_MENTIONS_AUTO_DRAFT=1` and `ZYQUOR_MENTIONS_ACCOUNTS=<account_id>` are set. `ZYQUOR_MENTIONS_INTERVAL_MS` overrides the cadence (default 15 min). Auto-draft only creates drafts for the review queue; it never posts.
- Mentions auto-approve (optional, stage 2, off by default): when `ZYQUOR_MENTIONS_AUTO_APPROVE=1` the worker calls the capped lane endpoint instead (precedence over auto-draft if both are set). The lane drafts with wiki-only memory and may approve at most `ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP` (default 3, 0 disables) qualifying top candidates per account per local day into ordinary `review_required` post jobs; everything else stays in the review queue. The lane never posts.

## Safety rules

These are hard rules. A violation is worse than a failed operation.

1. The review queue is the gate. Drafting, scanning, regenerating, and editing are all safe and reversible, but approving or posting requires the user to ask for it explicitly in this conversation. "Scan and draft replies" is not permission to post.
2. Never call `POST /jobs/post-next`, `POST /jobs/post-ready`, `POST /jobs/:id/post`, or approve with mode `autopost` unless the user explicitly asked to post. Agent approvals must always send `"screened":true` on `POST /drafts/:id/approve`; the route then refuses (409) text below the quality floor, unclean text, or text over the tweet length limit. Never omit the screen.
3. Never retry failed jobs autonomously. `POST /jobs/:id/retry` exists for explicit human asks: it is verify-then-retry (scans the target thread for the account's own reply first; if that thread refuses to render, falls back to scanning the account's replies timeline; marks the job posted when either scan finds the reply, and only reposts through the fully gated path when both scans confirm the reply never landed). Agents may run it only when the user asks, never on their own when a flow errors. `POST /jobs/recover-stale` exists solely for the worker's own stale-job reaping; do not call it from an agent session.
4. Never delete (drafts, jobs, accounts, post history) without the user asking. Deletion is permanent.
5. Never modify generation or style settings without the user asking. Settings changes shape every future post.
6. Drafts can contain grounded personal memory (wiki facts, activity excerpts) from the user's own machine. Never quote that internal memory verbatim into a conversation outside drafting context, and never paste private memory into public-facing text anywhere except inside Zyquor's own draft generation.
7. Scheduling (`scheduled`) is safe to apply only when the user asked for scheduling. It creates a queued job with a future `scheduledFor`; it does not post by itself.
8. Never call `POST /replies/mentions/scan-and-auto-approve` without an explicit ask. Even though the lane is capped and queue-first, one call can approve up to the daily cap of drafts without a human in the loop, so for agents it counts as an approval action, not a drafting action. It exists for the user's own worker configuration, not for autonomous agent use.
9. Generated text must never read stupid: the prompts ban fake-profound aphorisms, tech-bro clichés, contrived wordplay, and hedges that dodge direct questions. If a candidate reads like it was written to impress rather than to say something true, regenerate or delete it instead of approving it.
10. Never clear x.com cookies, site data, or force a re-login to "fix" a browser error. Read the error first. If it says `X did not render the authenticated shell ... not a logout`, the session is fine and the page is hung: relaunch the profile and retry. Clearing site data deletes a real session and turns a render bug into a forced login. Only a login URL, a visible login form, or a failed credentials check means the account is actually logged out.

## Discover the API base

```bash
API="http://127.0.0.1:3001"
curl -s "$API/health" 2>/dev/null || API="http://127.0.0.1:3000"
curl -s "$API/health"
# => {"ok":true,...}
```

Every list endpoint returns a JSON object with the collection under a named key. HTTP errors return `{"error": "..."}` (plus `{"issues": [...]}` for validation). Draft 409s are normal business logic (already posted, daily limit reached, quality gate failure), not crashes; relay the exact message to the user.

## Accounts

```bash
curl -s "$API/accounts"            # {"accounts":[{id, handle, displayName, enabled, profileDir, styleProfileId, dailyPostLimit, quietHoursStart, quietHoursEnd}]}
curl -s "$API/browser/active"      # which account currently owns the posting Chrome profile, if any
```

The default seeded account id is `account_personal`. Reply routes accept `accountId` and default to it.

## Mentions flow (the replies-first flow)

All replies go through drafts; the review queue is applied everywhere.

1. Scan (read-only, shows who is actionable):

```bash
curl -s "$API/replies/mentions?accountId=account_personal"
# => {"mentions":[{"authorHandle":"...","text":"...","url":"https://x.com/.../status/...","publishedAt":"...","drafted":false,"posted":false}], "scanned": N, "adsSkipped": N}
```

Mentions are fresh within the last 48 hours; rows marked `drafted` or `posted` are already handled.

2. Draft in bulk (creates one draft per fresh mention, capped at 10 per call):

```bash
curl -s -X POST "$API/replies/mentions/scan-and-draft" -H 'content-type: application/json' \
  -d '{"accountId":"account_personal"}'
# => {"scanned":N,"created":[{"draft":{...},"candidates":[...]}],"skipped":[{"url":"...","reason":"drafted|posted|unavailable|promoted"}],"adsSkipped":N}
```

3. Draft selected URLs only:

```bash
curl -s -X POST "$API/replies/mentions/draft" -H 'content-type: application/json' \
  -d '{"accountId":"account_personal","mentions":[{"url":"https://x.com/who/status/123"}]}'
```

4. Reply to any specific post URL (draft only, never posts):

```bash
curl -s -X POST "$API/replies/from-url" -H 'content-type: application/json' \
  -d '{"accountId":"account_personal","url":"https://x.com/who/status/123"}'
# => {"draft":{...},"candidates":[...],"replyTo":{...},"memory":{"used":true,"terms":[...],"wikiCount":1,"memoryCount":2}}
```

The fetch also captures up to 6 replies already posted under the target (220 chars each, deduped, link spam dropped; hard 1200-char cap in the prompt) and passes them to the draft prompt (`metadata.sourceReplies` count, `replyContext.otherReplies`), with an explicit instruction not to repeat or paraphrase them. Reply prompts carry a direct-answer rule: when the target asks a question, the candidate must name a pick instead of hedging into decision-framework advice. Set `ZYQUOR_LLM_DEBUG=1` to drop the exact raw prompt and raw model output into `data/artifacts/llm-input-*.txt` and `llm-output-*.txt` for auditing. Optional `"count":1..50` on the same call drafts that many distinct candidates (best-of-N; one top-up pass for small N, up to four extra passes with a no-repeat nudge for large N, so big pools fill with different angles); pick the strongest candidate, then approve (`screened:true`, see the approve section). Candidates stay on the draft and the reviewer orders them best first.

`memory` reports whether Goldfish personal memory grounded the draft (`used` plus counts, or a `reason`: `disabled`, `empty`, `unavailable`). With this skill's default posture (`useMemory` absent), it follows the account's `rules.replyMemory` style setting.

4b. Capped auto-approve lane (explicit ask only, see safety rule 8): drafts fresh mentions with wiki-only memory (activity excerpts are never injected) and approves the top candidate into a `review_required` job only when it clears the quality floor, within the daily cap:

```bash
curl -s -X POST "$API/replies/mentions/scan-and-auto-approve" -H 'content-type: application/json' \
  -d '{"accountId":"account_personal"}'
# => {"scanned":N,"created":[...],"approved":[{"url","draftId","text"}],"held":[{"url","reason"}],"skipped":[...],"adsSkipped":N,"dailyCap":3,"remainingToday":M}
```

Held reasons: `quality_below_floor`, `daily_cap_reached`, `no_candidates`, `draft_failed:...`, `approve_failed:...`. Held drafts stay in the review queue untouched; nothing posts from this endpoint. The lane does not accept per-call memory or cap overrides by design: caps come from env, memory is wiki-only.

5. Existing reply drafts: `GET /replies/drafts?accountId=...` returns `{drafts}` filtered to reply targets.

Note: hitting mentions endpoints requires the account's posting Chrome to be running with remote debugging for that profile (Zyquor opens the mentions tab through the persistent profile). If the scan errors with a browser message, say so and ask the user to start Chrome for that account, rather than trying to repair login state yourself.

## Browser failures vs logouts

`X profile is not logged in` and `X did not render the authenticated shell` are different errors with different fixes. Do not treat them as the same.

- Render failure: the page loads the X shell but stays on the `Loading…` placeholder. `document.body.innerText` is empty, there are no console errors, and X's own endpoints (`viewer_context.json`, `account/settings.json`, `HomeTimeline`) still return 200. The session is valid. Relaunch the dedicated Chrome profile and retry. If the same profile still will not render after a relaunch, switch to a fresh profile and log in once.
- Real logout: the URL is a login or onboarding route, a login form is visible, or the credentials endpoint returns no handle. Only then does a human need to log in.
- Never clear x.com site data or cookies on either error. That deletes the session and forces the login you were trying to avoid.

Port topology on the owner's machine: the API talks to `http://172.31.96.1:9223`, a Windows `netsh` portproxy to `127.0.0.1:9222`. Chrome binds 9222 to loopback, so use 9223 from WSL.

Posting also depends on the per-profile CDP port. `perProfileCdpUrl` gives each profile its own port; profiles in `ZYQUOR_BROWSER_CDP_BASE_PROFILES` (comma separated, default `personal-main`) stay on the base port, everything else gets a hash offset. If posting fails with `Chrome CDP is unavailable at http://172.31.96.1:9224`, the active profile is not on a forwarded port. Add it to that env list; do not open more portproxy rules.

Posting Chrome runs headless here (`ZYQUOR_BROWSER_HEADLESS=1`, `--headless=new`) on the same profile and CDP port, so no window appears. `ensureBrowserCdp` honours the flag, so auto-launch after a CDP drop stays headless too. Restart with `C:\Users\asus\zyquor-profiles\relaunch-fresh.ps1`; use `relaunch-headed.ps1` only to debug a page that will not render. Debug headless through screenshots in `apps/api/data/artifacts`, not a visible window.

The desktop app exposes the same switch as a `Headless posting Chrome` checkbox in Settings, stored as `headless` in `settings.json` and mapped to `ZYQUOR_BROWSER_HEADLESS` at startup. Its launcher resolves ports through `perProfileCdpUrl` from `@zyquor/core`, the same helper the API uses, so a port fix lands for both. Desktop links open in the system browser; if a click opens a blank Electron window instead, the `setWindowOpenHandler` / `will-navigate` handlers in `apps/desktop/src/main.ts` were removed. Desktop logs are buffered (100 ms), so a line can lag briefly; `main.log.1` is the previous 5 MB segment.

If a post fails partway, the composer can keep the text. Clear it (`Control+A`, `Backspace`) before the next attempt. Otherwise the next navigation raises Chrome's `beforeunload` dialog, and Playwright's auto-dismiss used to crash the API with `No dialog is showing`. That crash is now contained by dialog handlers and an unhandled-rejection logger, but the dirty composer should still be cleared.

Posted replies record their own permalink now. If history points at the target tweet instead, the reply was stored by an older build; open the account's reply and correct the URL rather than assuming the reply posted to the wrong place.

## Posts-only reply loop

`scripts/reply-loop.mjs` is the unattended posts-only lane. It never touches mentions. Each cycle it reads the home feed first (`GET /replies/feed`, people the owner follows), falls back to X search through the logged-in Chrome when the feed is thin, already seen, or rejected, drafts best-of-N via `POST /replies/from-url`, screens the candidates with a deterministic slop filter, and only then approves (`screened:true`) and posts through the normal gated job path.

```bash
node scripts/reply-loop.mjs --once --dry   # discover, draft, report; no approval
node scripts/reply-loop.mjs --once         # one cycle, may post
node scripts/reply-loop.mjs                # run continuously, default 12 min interval
```

- Every decision, including each rejected candidate and the reason, is appended to `apps/api/data/reply-loop.jsonl`. Seen targets and query rotation live in `apps/api/data/reply-loop-state.json`, saved after every decision so a restart does not re-reply to a seen target.
- Discovery runs feed first, then search, each query on its own browser connection. Running search concurrently with the feed scan kills the search page, because the API feed request closes its own browser context.
- The filter rejects: too short or over 279 chars, questions the target did not ask, advice imperatives, formula contrasts, slop words, numbers not present in the target, first-person review phrasing, and anything under the quality floor.
- This starts a real posting lane. Run it only on an explicit ask, never as a diagnostic. `--dry` is safe.
- Prompt rules are added only when a rejection reason repeats in the log. Do not bolt speculative instructions onto the prompt.

## Review the queue

```bash
curl -s "$API/replies/drafts?accountId=account_personal"   # {"drafts":[{id, status, sourceInput, editedText, replyTo, metadata}]}: reply drafts awaiting review (usually status "selected")
curl -s "$API/drafts/:id"                                 # one draft, full with candidates
```

Draft statuses move `selected -> approved` when approved. `approved` means a post job exists; the job still waits for the worker and browser posting. Anything with status `created` has no candidates yet.

## Approve a draft

Only when the user explicitly asked to approve. Agents MUST always send `"screened":true`: the server then enforces the quality floor, text cleanliness, and the tweet length limit itself and answers 409 with reasons when the text fails. Never omit or disable the screen for an agent-initiated approval; humans may omit it to override. Reply drafts screen against their own floor (`ZYQUOR_REPLY_QUALITY_MIN`, default 5) because the mechanical scorer was calibrated on long-form posts; post drafts keep the full floor (`ZYQUOR_QUALITY_MIN`, default 7).

```bash
curl -s -X POST "$API/drafts/:id/approve" -H 'content-type: application/json' \
  -d '{"editedText":"final approved text","mode":"review_required","screened":true}'
```

Delete with the user's ask only:

```bash
# Delete an unposted draft (removes it and its job linkage):
curl -s -X DELETE "$API/drafts/draft_xxx"
# Delete a posted reply straight off X through the posting Chrome (identity-checked,
# requires ZYQUOR_ENABLE_BROWSER_POST + CoreX logged in on the account profile):
curl -s -X POST "$API/history/history_xxx/delete"
```

Modes:
- `draft_only`: mark approved text, no posting job.
- `review_required` (default): create a post job that stays in the queue.
- `scheduled`: `scheduledFor` ISO timestamp required (e.g. `2026-10-26T21:30:00Z`); queues it for that time.
- `autopost`: also queues for immediate dispatch. Only with an explicit post request.

## Post jobs

```bash
curl -s "$API/jobs"                                  # {"jobs":[...]} (supports ?accountId=)
curl -s "$API/jobs/:id/attempts"                     # error history for inspection and reporting
curl -s -X POST "$API/jobs/post-next"                # posts exactly one ready job (explicit ask only)
curl -s -X POST "$API/jobs/post-ready" -d '{"accountId":"account_personal"}'   # drains ready jobs (explicit ask only)
```

Jobs only actually post when the posting browser is connected (desktop `enableBrowserPost`) and account limits (daily cap, quiet hours, spacing) allow it. When a post fails, the job keeps the error in attempts; report it and stop.

## History and performance

```bash
curl -s "$API/history"             # recent posts with sources; supports ?accountId= and ?limit
curl -s "$API/history/analysis"    # posture analysis
curl -s "$API/performance"         # per-tweet metrics
```

## Generation side (posting ideas, not replies)

```bash
curl -s "$API/ingest-run" -X POST          # ingest sources, then
curl -s "$API/source-packets"              # {"sourcePackets":[...]}
curl -s -X POST "$API/drafts" -H 'content-type: application/json' \
  -d '{"accountId":"account_personal","idea":"...","tweetType":"opinion"}'
```

## Editing drafts before approval

```bash
# pick one of the generated candidates
curl -s -X POST "$API/drafts/:id/select" -H 'content-type: application/json' -d '{"candidateId":"cand_..."}'
# regenerate candidates
curl -s -X POST "$API/drafts/:id/generate"
```

There is no draft PATCH endpoint: the final text is supplied at approve time as `editedText`. Prefer the web UI for human edits when it is running; agents pass the corrected text into the approve call only when the user approved it.

## Brief recipes

- "Scan my mentions and draft replies" = `GET /replies/mentions`, summarize who is actionable, then (only if the user asked to actually draft) `POST /replies/mentions/scan-and-draft`. Report created vs skipped with reasons. If the user asks to "let it approve automatically" or mentions the capped lane, treat that as the explicit ask needed for `scan-and-auto-approve`, and still report exactly what was approved vs held.
- "What's pending?" = `GET /drafts/pending`, summarize statuses, offer next actions. Never approve unprompted.
- "Post X for me" = approve with the mode the user asked for, then (if they asked for actual posting) `POST /jobs/post-next` and report the result. If posting is disabled or limits block the job, relay the returned message.
- "How did posts do?" = `GET /performance` (+ `/history` for context).

## Install (any agent CLI)

The workspace copy lives at `skills/zyquor/SKILL.md`. Install a copy for any agent CLI:

```bash
mkdir -p ~/.agents/skills && cp -r skills/zyquor ~/.agents/skills/     # agent-agnostic (AGENTS.md ecosystem)
mkdir -p ~/.claude/skills && cp -r skills/zyquor ~/.claude/skills/    # Claude Code
mkdir -p ~/.config/opencode/skill && cp -r skills/zyquor ~/.config/opencode/skill/  # opencode
```

The skill only uses curl and JSON: any CLI that can run shell commands can use it.

## Repo layout pointers

- App source: `apps/api`, `apps/worker`, `apps/web`, `apps/desktop`.
- Engine packages: `packages/browser` (Chromium via CDP), `packages/generation` (LLM providers), `packages/storage` (SQLite), `packages/automation` (selection, posting pipeline), `packages/adapters` (source adapters incl. Goldfish memory), `packages/accounts`, `packages/core` (schemas).
- Spec and phase plan: `tasks/replies-first-goldfish.md`. Architecture notes: `docs/architecture.md`.
- Demo-check queue for external URLs found in mentions: `services/demo-checker/run-queue.mjs` (cron wrapper `scripts/mentions-cron-wrapper.sh`, poller `scripts/poll-x-mentions.mjs`).
