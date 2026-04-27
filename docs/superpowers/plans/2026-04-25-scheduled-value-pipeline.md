# Scheduled Value Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two post lanes: user-directed idea posts and automated daily value posts, both scheduled with account-specific personality and rules.

**Architecture:** Keep review-first safety as default. Non-LLM tools ingest sources, normalize facts, score topics, dedupe, and choose schedule slots. The LLM is only the last-mile tweet writer: it receives a compact source packet plus personality/rules and returns candidate tweet text.

**Tech Stack:** TypeScript, Fastify, Vite React, SQLite/JSON fallback, Vitest, Playwright Chrome CDP.

---

## Product Model

Two lanes:

1. `idea` lane: user supplies the topic or tweet idea. Zyquor generates candidates, user edits, approves, schedules, then prepare/post executes at scheduled time.
2. `auto_daily` lane: Zyquor creates daily draft ideas from configured categories such as feed observations, news, information, guides, opinion, lessons, and tools. These drafts must still follow personality/rules, avoid duplicates, respect quiet hours, and schedule naturally.

Safety defaults:

- `scheduled` means approved post waits until `scheduledFor`.
- `autopost` remains future-gated. Automated lane creates scheduled/reviewable jobs first.
- Final public post click still requires `ZYQUOR_ENABLE_BROWSER_POST=1`.

LLM boundary:

- The LLM must not browse, schedule, scrape, rank, dedupe, or decide whether to post.
- Source tools produce compact `source_packets` with URL/title/date/summary/key facts.
- Deterministic code chooses which packet becomes a draft and when it should be scheduled.
- The generation provider receives only the selected packet, account personality, and rules.
- The generation provider returns tweet candidates only.
- Validators reject duplicates, banned phrases, overlong text, missing source attribution when required, and scheduled times inside quiet hours.

## File Map

- Modify `packages/core/src/index.ts`: source type, style profile rules schema, schedule request schema.
- Modify `packages/core/src/state.ts`: allow `approved -> approved` through schedule metadata update by repository method, not status transition.
- Modify `packages/storage/src/index.ts`: accept approval options, store `scheduledFor` and `mode`, list due jobs.
- Modify `apps/api/src/app.ts`: schedule approved jobs, list due jobs, block prepare/post before schedule time.
- Modify `apps/api/src/app.test.ts`: cover scheduled approval, premature prepare block, due prepare allowed.
- Modify `apps/web/src/main.tsx`: add schedule input, posting mode awareness, X status check already present.
- Modify `apps/web/src/styles.css`: schedule controls responsive layout.
- Later create `packages/generation/src/auto.ts`: automated daily prompt plans.
- Later create `packages/sources`: deterministic source ingestion adapters for RSS/news/feed/bookmark/manual notes.
- Later create `apps/worker/src/scheduler.ts`: poll due scheduled jobs and prepare/post based on account mode.

---

### Task 1: Scheduled Approval Core

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/src/index.test.ts`

- [ ] **Step 1: Add approval request fields**

Add optional `scheduledFor` and `mode` to `approveDraftRequestSchema`:

```ts
export const approveDraftRequestSchema = z.object({
  editedText: z.string().min(1).max(4000),
  mode: z.enum(POSTING_MODES).optional(),
  scheduledFor: isoTimestampSchema.nullable().optional()
});
```

- [ ] **Step 2: Update repository interface**

Change `approveDraft(input: { draftId; editedText })` to include:

```ts
mode?: PostJob["mode"];
scheduledFor?: string | null;
```

- [ ] **Step 3: Store scheduled jobs**

When creating `PostJob`, set:

```ts
mode: input.mode ?? "prepare_only",
scheduledFor: input.scheduledFor ?? null,
```

- [ ] **Step 4: Add tests**

Create storage test asserting scheduled approval stores `mode: "scheduled"` and exact ISO `scheduledFor`.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @zyquor/core check
pnpm --filter @zyquor/storage test
```

Expected: all pass.

### Task 2: API Schedule Guard

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`

- [ ] **Step 1: Pass approval schedule fields**

In `/drafts/:id/approve`, call:

```ts
repository.approveDraft({
  draftId: id,
  editedText: input.editedText,
  mode: input.mode,
  scheduledFor: input.scheduledFor ?? null
});
```

- [ ] **Step 2: Block premature prepare/post**

Before browser work, add:

```ts
if (job.scheduledFor && Date.parse(job.scheduledFor) > Date.now()) {
  return reply.code(409).send({ error: `Job is scheduled for ${job.scheduledFor}` });
}
```

- [ ] **Step 3: Add API tests**

Test approving with future schedule returns job with `scheduledFor`, and prepare returns `409`.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @zyquor/api test
```

Expected: all pass.

### Task 3: Web Scheduling Controls

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add schedule state**

Add state:

```ts
const [approvalMode, setApprovalMode] = useState("prepare_only");
const [scheduledFor, setScheduledFor] = useState("");
```

- [ ] **Step 2: Send schedule payload**

In `approveDraft`, include:

```ts
mode: approvalMode,
scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null
```

- [ ] **Step 3: Add UI controls**

Add mode select and `datetime-local` field near `Approve job`.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @zyquor/web check
```

Expected: all pass.

### Task 4: Personality Rules

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Expose style profiles**

Add `listStyleProfiles`, `getStyleProfile`, and `updateStyleProfile` to repository.

- [ ] **Step 2: Add `/style-profiles/:id` API**

Allow editing tone, rules, banned phrases, and examples.

- [ ] **Step 3: Feed rules into generation**

Include account style profile in generation input. Prompt must include:

```text
Goal: provide useful, meaningful posts that can earn reach without clickbait.
Personality:
- clear
- specific
- useful
Rules:
- no fake certainty
- no engagement bait
- one idea per post
- concrete takeaway
```

- [ ] **Step 4: Verify**

Run `pnpm test`.

### Task 4: Personality Rules

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/main.tsx`

- [x] **Step 1: Expose style profiles**
- [x] **Step 2: Add `/style-profiles/:id` API**
- [x] **Step 3: Feed rules into generation**
- [x] **Step 4: Verify**

---

## Completed Sections

**Task 1 (Scheduled Approval Core):** Done.
**Task 2 (API Schedule Guard):** Done.
**Task 3 (Web Scheduling Controls):** Done.
**Task 4 (Personality Rules):** Done.

## Remaining: Task 5 + Task 6

### Task 5: Deterministic Source Packets

Partially done (source packet schema, API, storage, UI exist).
**Remaining:** `packages/sources` package with deterministic scorer + source adapters.

### Task 6: Automated Daily Draft Queue

**Remaining:**
- `POST /ingest-run` endpoint that reads enabled configs and creates packets/drafts/jobs
- Worker integration to run ingest on schedule
- Tweet type selection from `tweetTypeMix` weights (not random)
- Natural schedule slot selection (outside quiet hours, with jitter)
