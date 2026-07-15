# Plan 005 (spike): Feed real example tweets into generation via style profiles

> **Executor instructions**: This is an INVESTIGATE-AND-DESIGN spike, not a
> build plan. The deliverable is a written design (appended to this file under
> "## Spike findings") plus at most a thin proof-of-concept behind existing
> interfaces. Follow the steps, honor the STOP conditions, and update the
> status row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 91f3988..HEAD -- packages/generation/src/index.ts apps/api/src/app.ts`
> The `systemPrompt()` excerpt below comes from the 2026-06-12 working tree;
> if it moved, locate the equivalent code before proceeding.

## Status

- **Priority**: P2
- **Effort**: M (spike S, later build M)
- **Risk**: LOW (spike is read-mostly)
- **Depends on**: plans/001-fix-date-sensitive-history-test.md (for verifying any PoC)
- **Category**: direction
- **Planned at**: commit `91f3988` (uncommitted generation changes in working tree), 2026-06-12

## Why this matters

The single biggest lever for authentic-sounding generated tweets is showing the
model the account's real voice — actual past tweets — rather than describing
the voice in adjectives. The plumbing half-exists: every style profile has a
`systemPromptExtra` field that `PATCH /style-profiles/:id` can set and that
`systemPrompt()` in `packages/generation/src/index.ts` already appends as
"Extra user system prompt". What's missing is a first-class, structured way to
store example tweets and render them as calibration examples (the prompt
already contains three generic weak→strong pairs; account-specific examples
should join or replace them). There is also an unexploited signal source:
`GET /history/analysis` computes post-history quality data that nothing
currently consumes.

## Current state (verified 2026-06-12)

- `packages/generation/src/index.ts` — `systemPrompt(input)` ends with:

  ```ts
  input.systemPromptExtra ? `Extra user system prompt:\n${input.systemPromptExtra}` : ""
  ```

  and earlier includes `...VOICE_EXAMPLES` — a constant holding three generic
  weak→strong example pairs with the header "Voice calibration. These pairs
  show tone and shape only. Never reuse their facts, topics, or wording."

- `GenerateDraftCandidatesInput` (same file) carries `systemPromptExtra`,
  `tone`, `objective`, `bannedPhrases` — populated per account by
  `accountGenerationContext` in `packages/automation/src/context.ts` (not yet
  read in detail — the spike must read it).
- API surface (from CLAUDE.md, not yet read in code):
  `GET /style-profiles/:id`, `PATCH /style-profiles/:id` updating
  tone/rules/bannedPhrases/systemPromptExtra; `GET /history/analysis?accountId=&sinceHours=`.
- Storage: style profiles persist via `packages/storage` (sqlite + memory dual
  implementation — any schema change must land in BOTH, plus
  `packages/storage/src/mappers.ts`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `pnpm build` | exit 0 |
| Generation tests | `cd packages/generation && pnpm exec vitest run --pool=threads` | all pass |
| Storage tests | `cd packages/storage && pnpm exec vitest run --pool=threads` | all pass |
| API tests | `cd apps/api && pnpm exec vitest run --pool=threads` | all pass |

Note: if `pnpm` is not on PATH, use `node "$(npm root -g)/pnpm/bin/pnpm.cjs"` (per CLAUDE.md).

## Scope

**In scope (spike)** — reading, plus PoC edits ONLY if zero schema changes are needed:
- Read: `packages/automation/src/context.ts`, style-profile routes in
  `apps/api/src/app.ts`, style-profile types in `packages/core/src/index.ts`,
  style-profile persistence in `packages/storage/src/{sqlite,memory,mappers}.ts`,
  style panel in `apps/web/src/main.tsx`, history-analysis route.
- Write: the "Spike findings" section of THIS file.

**Out of scope**:
- Any schema/storage change in the spike. (The design may propose one; the
  build phase implements it as its own plan.)
- Any change to posting, jobs, or the worker.
- LLM-based ranking or feedback loops where the LLM decides anything beyond
  candidate text — repo hard constraint: the LLM only writes candidate text.

## Steps

### Step 1: Map the real plumbing

Read the files listed in scope and document (in Spike findings): the exact
shape of a style profile record, how `accountGenerationContext` builds
generation input, where the web UI edits the style profile, and what
`GET /history/analysis` actually returns.

**Verify**: Spike findings contains a data-flow diagram in text form with
`file:line` references for each hop.

### Step 2: Decide example-tweet storage

Compare options against what Step 1 found (recommendation expected, with
trade-offs):
- A. Convention only: user pastes tweets into `systemPromptExtra` (zero code;
  weakest structure; cannot cap length or count).
- B. New `exampleTweets: string[]` field on the style profile (schema change
  in core + both storage backends + API + UI; clean rendering control).
- C. Derive examples automatically from `PostHistory` of successfully posted
  tweets (no manual curation, but recently-posted ≠ good voice, and history
  purges after 24h — verify that purge claim in code during Step 1).

**Verify**: Spike findings records the recommendation and why the losers lost.

### Step 3: Specify the prompt rendering

Write the exact function signature and prompt block for rendering account
examples (e.g. cap at 8 examples, ~280 chars each, header text modeled on the
existing `VOICE_EXAMPLES` header including the "never reuse their facts"
guard), and where it slots into `systemPrompt()` relative to the generic
`VOICE_EXAMPLES` (replace when account examples exist; keep generics as
fallback).

**Verify**: Spike findings contains the rendered prompt block for a 2-example
fixture, and states the token-budget impact for small free models.

### Step 4 (optional PoC, only if option A or zero-schema variant chosen)

Demonstrate end to end with the mock provider: set `systemPromptExtra` via
`PATCH /style-profiles/:id` containing two example tweets, generate a draft,
and show the prompt contains them. An existing api test in
`apps/api/src/app.test.ts` is the structural pattern for an injected-provider
test.

**Verify**: the PoC test passes; `git status` shows test-file changes only.

## Test plan

Spike: no production tests required. If Step 4 runs, one api-level test
proving `systemPromptExtra` flows into the provider's received system prompt.
The build-phase plan (written after this spike) carries the real test matrix.

## Done criteria

- [ ] "## Spike findings" appended to this file with: data-flow map, storage decision + rationale, prompt-block spec, build-phase task list with effort estimates
- [ ] No schema or storage files modified (`git status`)
- [ ] All existing tests still pass
- [ ] `plans/README.md` status row updated (DONE = findings written, even if the recommendation is "do nothing")

## STOP conditions

Stop and report back if:

- Style profiles turn out not to be per-account (e.g. one global profile) —
  the design premise changes; record what you found and stop.
- `systemPromptExtra` is truncated, sanitized, or otherwise transformed
  anywhere between API and provider call — document where and stop.
- The spike tempts you into implementing option B's schema change "while
  you're there" — that is explicitly the next plan, not this one.

## Maintenance notes

- Whatever lands must respect the hard constraint that deterministic code, not
  the LLM, decides everything except candidate text.
- Example tweets are user content: never log them at error level, and keep
  them out of failure artifacts if they flow near the browser package.
- Revisit the generic `VOICE_EXAMPLES` constant once account examples exist —
  generic examples should be fallback only.

## Spike findings

### 1. Data-flow map

```
StyleProfile.examplePosts (existing, unused)
  ↓ stored in SQLite `example_posts_json`, memory Map, mappers.ts:112
  ↓ API: PATCH /style-profiles/:id already accepts examplePosts (definedEntries passes it through)
  ↓ NOT read by accountGenerationContext (packages/automation/src/context.ts:13-26)
  ↓ NOT passed to GenerateDraftCandidatesInput (packages/generation/src/index.ts:7-16)
  ↓ NOT rendered in systemPrompt() (packages/generation/src/index.ts:245-285)
  ↓ NOT exposed in web UI (apps/web/src/main.tsx:111 defines type, no editor)

accountGenerationContext()
  → reads styleProfile.tone, .bannedPhrases, rules.objective, rules.systemPromptExtra
  → returns AccountGenerationContext { tone, bannedPhrases?, objective?, systemPromptExtra? }
  → should also return: examplePosts?: string[]

systemPrompt()
  → receives systemPromptExtra as: `Extra user system prompt:\n${input.systemPromptExtra}`
  → renders VOICE_EXAMPLES constant (3 generic weak/strong pairs) unconditionally
  → should: if examplePosts exist, render them as calibration examples IN PLACE OF or BEFORE VOICE_EXAMPLES

VOICE_EXAMPLES header (packages/generation/src/index.ts:178):
  "Voice calibration. These pairs show tone and shape only. Never reuse their facts, topics, or wording."

GET /history/analysis returns aggregated issues (duplicate_text, generic_phrasing, etc.)
  → does NOT return raw posted tweet text
  → cannot auto-derive example tweets from analysis output
  → PostHistory purges after 24h (POST_HISTORY_TTL_MS = 86,400,000 in apps/api/src/app.ts:206)
```

### 2. Storage decision

**Recommendation: Option B — use existing `examplePosts` field (ZERO schema change).**

| Option | Schema change | Code to touch | Curation | Verdict |
|--------|---------------|---------------|----------|---------|
| A. Convention (paste into systemPromptExtra) | None | None | Manual, no limits | Too weak — no struct |
| **B. Use existing examplePosts field** | **None** | 4 files | Manual, struct | **Right answer** |
| C. Auto-derive from PostHistory | None | 3+ files | Automatic | Bad — history purges 24h, analysis returns issues not text, recently-posted ≠ good voice |

`examplePosts: string[]` already exists in:
- `StyleProfile` schema (`packages/core/src/index.ts:106`)
- `updateStyleProfileRequestSchema` (`packages/core/src/index.ts:274`)
- SQLite table `style_profiles.example_posts_json` (`packages/storage/src/sqlite.ts:67`)
- Memory repo default `examplePosts: []` (`packages/storage/src/memory.ts:41`)
- SQLite <-> domain mapper (`packages/storage/src/mappers.ts:112`)
- Web UI style profile interface (`apps/web/src/main.tsx:111`)
- API `PATCH /style-profiles/:id` already accepts it (passes all fields via `definedEntries`)

What's missing: read-path wiring. Zero schema change, zero migration.

### 3. Prompt rendering spec

```ts
// In GenerateDraftCandidatesInput (packages/generation/src/index.ts:7-16)
// Add field:
examplePosts?: string[];

// In accountGenerationContext (packages/automation/src/context.ts:13-26)
// Return examplePosts from style profile:
examplePosts: styleProfile?.examplePosts && styleProfile.examplePosts.length > 0
  ? styleProfile.examplePosts
  : undefined

// In systemPrompt() (packages/generation/src/index.ts:245-285)
// Replace VOICE_EXAMPLES when account examples exist.
// Render block:

function renderCalibrationExamples(examplePosts?: string[]) {
  if (!examplePosts || examplePosts.length === 0) return VOICE_EXAMPLES;
  const capped = examplePosts.slice(0, 8);
  return [
    "Voice calibration from your real posted tweets instead of generic weak/strong pairs.",
    "These show YOUR tone, shape, and voice. Write new candidates that match this cadence and word choice. Never reuse these posts' facts, topics, or wording.",
    ...capped.map((text, index) => `${index + 1}. ${text.trim()}`)
  ];
}
```

Token-budget impact for small free models (e.g. `openrouter/owl-alpha`):
- 8 examples × ~280 chars ≈ ~560 tokens (output tokens, roughly 4 chars/token)
- Negligible for 120B models, noticeable but fine for sub-10B models if examples are short and count is low.
- Cap at 8 examples, ~280 chars each (enforced at API input validation).

### 4. Build-phase task list

| # | Task | Files | Effort |
|---|------|-------|--------|
| 1 | Add `examplePosts?` to `GenerateDraftCandidatesInput` | `packages/generation/src/index.ts` | S |
| 2 | Return `examplePosts` from `accountGenerationContext` | `packages/automation/src/context.ts` | S |
| 3 | Wire `examplePosts` through draft generation API callers | `apps/api/src/app.ts` (draft generate, source-packet draft, draft-batches) | S |
| 4 | Render calibration examples in `systemPrompt()` | `packages/generation/src/index.ts` | S |
| 5 | Add `examplePosts` textarea to web UI style panel | `apps/web/src/main.tsx` | S |
| 6 | Add test: examplePosts flow into mock provider system prompt | `apps/api/src/app.test.ts` or `packages/generation/src/index.test.ts` | S |

Total: <1 day. Zero schema change, zero migration.

### STOP condition check

- Style profiles ARE per-account (via `Account.styleProfileId` referencing `StyleProfile.id`). ✅ premise holds.
- `systemPromptExtra` is NOT truncated or transformed — passed raw into prompt. ✅ safe.
- `examplePosts` is already in schema and API — no schema-change temptation. ✅ safe.
