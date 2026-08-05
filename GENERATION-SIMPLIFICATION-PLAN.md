# Plan: Simplify LLM generation to a single call + minimal quality scoring

Status: **completed 2026-08-05** (implemented & validated — see Step Log)
Owner: Cline
Scope: `packages/generation`, `packages/automation`, `apps/api`, `CLAUDE.md`

## Problem

Producing one draft today can make **3-7 LLM calls** per provider, orchestrated by
`packages/generation/src/refine.ts` -> `generateWithQualityLoop`:

```
insight -> generate(system+user) -> audit -> reader-critique -> reader-revise -> reader-critique(again) -> [final audit (strict codex/command-code)] -> [repair] -> [line retry]
```

Every pass is executed by the **same model, same temperature (0.65)**, just re-rolled
as a different "role" (writer / fact checker / reader critic / rewriter). This has two
costs:

- **Cost & latency** - up to ~7 round-trips to produce one tweet.
- **Quality** - a model editing its own output through repeated keep/revise/drop rounds
  converges on *safe consensus prose* that is clean but flattening; it removes slop but
  also sands off the idiosyncrasy that makes a human take feel alive.

On top of that there is a **second, separate LLM**: the Ollama quality judge
(`evaluator.ts` + `apps/api/src/lib/quality-judge.ts`) that fires per candidate in the
API manual-"evaluate" flow and the yolo/auto-approve gate. So a single autopost can
touch the model many times.

Separately confirmed: **there is no 280-char cap in code today** (the old
`xPostCharacterLength <= 280` zod refinement was deleted in commit `8d09c58`). The only
remaining length influence was a soft heuristic in `scoreReadability` that nudged a
score by +1 for 90-260 chars and -1 for <60 or >270. `CLAUDE.md:19` still falsely
claimed "X free-tier character limit enforced at 280."

## Goals

1. Collapse generation to a **single LLM call** (one write), plus one lightweight
   `linePrompt` retry that fires **only** when the first output can't be parsed.
2. **Remove the separate quality-judge LLM** entirely; the deterministic quality floor
   becomes the sole quality gate.
3. **Simplify / revamp the quality scoring** system: fewer, legible checks; no length
   micro-penalties; no 280 cap.
4. Keep the anti-slop heart of the prompts (authenticity rules, punctuation rules,
   per-type style contracts + quality bars, injected banned phrases, source-boundary /
   prompt-injection defense) - this is what actually reduces AI slop, and it costs
   nothing extra.

## Design decisions

- **All anti-slop guidance already lives in `systemPrompt` / `userPrompt`.** The
  multi-pass helper prompts were redundant scaffolding on top of it, so deleting them
  loses no anti-slop signal.
- **Retry uses the same provider channel (`runPrompt`) with `linePrompt`.** Keep retry
  simple; candidates are parsed by `candidatesFromText`, which already handles
  plain-line output. (Behavior change: the retry keeps the JSON-format flag instead of
  dropping it - functionally fine, tests updated to match.)
- **The `/drafts/:id/evaluate` endpoint becomes deterministic.** It no longer calls an
  LLM; it recomputes `scoreTweetQuality` per candidate and persists it. No job created.
- **yolo/auto-approve gate is now floor + slop only.** Sorting drops `judgePass` /
  `judgeScore`; the gate is `passesTweetQualityFloor` + `AI_SLOP_PHRASES` substring
  check. The `quality_judge_rejected_all` reason no longer exists; rejections report
  `all_below_quality_floor` or `ai_slop_phrase_detected`.

## Changes (file-by-file)

### packages/generation

- **`src/refine.ts`** - replaced the multi-pass `generateWithQualityLoop` /
  `applyReaderCritique` with a single public `generateDraftCandidates`:
  1. `initial = runInitial?.(gi) ?? runPrompt(systemPrompt + \"\\n\\n\" + userPrompt)`;
  2. parse via `candidatesFromText`;
  3. on the exclusive "no candidates" error, retry once with `runPrompt(linePrompt(gi))`,
     otherwise rethrow.
  Deleted: `ReaderVerdict`, `parseReaderCritique`, `needsReaderRevision`,
  `formatCritique`, `READER_REJECTED_ALL`, `parseInsight`, `critiqueCoversCandidates`,
  `dropRejectedCandidates`, `applyReaderCritique`, `generateWithQualityLoop`.
- **`src/prompts.ts`** - deleted `tweetTypeInsightDirection`, `insightPrompt`,
  `auditPrompt`, `readerCritiquePrompt`, `readerRevisePrompt`, `repairPrompt`, and the
  `insight` block inside `userPrompt`. Kept `systemPrompt`, `userPrompt`, `linePrompt`,
  `tweetTypeInstruction`, all style contracts, `AUTHENTICITY_RULES`,
  `PUNCTUATION_RULES`, `VOICE_REFERENCES`, `bannedPhraseList`, `contextBlock`,
  `accountFeedbackSection`, `accountVoiceSections`, and the prompt-injection guards.
- **`src/quality.ts`** - removed `scoreReadability` (all length taps) and the unused
  `hasWeakEnding` helper. Rewrote `scoreTweetQuality` to a short, legible set:
  base 3, +1 number, +1 link, +<nouns up to 3>, +2 if any payoff signal, -3 source
  artifact, -3 recap, -2 weak opener, -2 adjective bloat. Kept `isCleanTweetText`,
  `formatTweetText` / `postProcessTweetText`, `passesTweetQualityFloor`,
  `qualityMinimum`, `candidatesFromText`.
- **`src/evaluator.ts`** - deleted (Ollama judge + `JUDGE_PROMPT`).
- **`src/index.ts`** - removed `evaluateTweetQuality` + evaluator/reader exports; added
  `export { generateDraftCandidates } from \"./refine.js\"`.
- **`src/types.ts`** - removed now-unused `insight` and `insightRequired` fields from
  `GenerateDraftCandidatesInput`.
- **providers/** (`openrouter`, `ollama`, `gemini`, `codex`, `command-code`) - switched
  `generateWithQualityLoop` -> `generateDraftCandidates`; dropped the inline
  `linePrompt` catch-blocks (now centralized in the retry) and the forced
  `insightRequired: true` in codex/command-code. Ollama/OpenRouter no longer import
  `linePrompt` / `candidatesFromText` / `isNoCandidatesError`.

### packages/automation

- **`src/draft.ts`** - removed `PacketDraftOptions.qualityEvaluator` /
  `qualityEvaluatorOptions`; removed the full judge loop and `judgePass` filtering;
  changed the quality-gate reason to `all_below_quality_floor` / `no_candidates_generated`;
  dropped `insightRequired: true` from `generateCandidatesForPacket`.
- **`src/ingest.ts`** - removed `qualityEvaluator` / `qualityEvaluatorOptions` from
  `RunAutomaticIngestOptions` and the two spreads passing them to `draftFromSourcePacket`.

### apps/api

- **`src/app.ts`** - removed the `evaluateTweetQuality` import and the
  `tweetQualityEvaluator: options.tweetQualityEvaluator ?? evaluateTweetQuality` wiring.
- **`src/deps.ts`** - removed `tweetQualityEvaluator` from `BuildAppOptions` and
  `AppDeps`, and its import.
- **`src/routes/drafts.ts`** - `/evaluate` now recomputes deterministic
  `scoreTweetQuality` and persists it; `/generate`'s yolo branch drops judge-based
  sorting/gating; the create-draft route no longer passes `qualityEvaluator`. Removed
  `qualityJudgeOptions` / `runQualityJudge` and `articleTweetIdea` imports.
- **`src/routes/ingest.ts`** - removed `qualityJudgeOptions` and the
  `qualityEvaluator` / `qualityEvaluatorOptions` spreads in `/ingest-run` and
  `/ingest-run/async`.
- **`src/routes/source-packets.ts`** - removed `qualityJudgeOptions` and the
  `qualityEvaluator` / `qualityEvaluatorOptions` spread on auto-approve.
- **`src/lib/quality-judge.ts`** - deleted.

### docs

- **`CLAUDE.md`** - replaced the two-layer multi-pass description with the single-call
  flow + deterministic floor + "no separate LLM judge"; removed the false "X free-tier
  character limit enforced at 280" claim.

## Tests

- **`packages/generation/src/index.test.ts`** - removed the judge import + the
  "tweet quality evaluator" describe block; updated the openrouter/ollama "retry with
  line prompt" mocks & assertions for the new same-channel retry (retry now keeps
  `format` / `response_format`); recomputed expected `score.quality` values for the new
  scorer; kept the `scoreTweetQuality` ranking + `isCleanTweetText` slop tests.
- **`apps/api/src/drafts-evaluate.test.ts`** - rewrote to the deterministic re-score
  behavior (no judge, no job) + a 404 case.

## Validation (run and passing)

- `pnpm --filter @zyquor/generation build` => OK; tests **20/20**
- `pnpm --filter @zyquor/automation build` => OK; tests **14/14**
- `pnpm --filter @zyquor/api build` => OK; tests **68/68**
- `pnpm --filter @zyquor/worker build` => OK
- `pnpm --filter @zyquor/web build` (tsc + vite) => OK
- Whole-repo grep for removed symbols => **CLEAN, zero lingering references**

---

## Step Log (each step done; file updated after each)

1. **Plan file created** - root `GENERATION-SIMPLIFICATION-PLAN.md`.
2. **`quality.ts`** - removed `scoreReadability` + `hasWeakEnding`; rewrote
   `scoreTweetQuality` to the minimal check set. Built OK.
3. **`prompts.ts`** - removed insight/audit/reader-critique/reader-revise/repair prompts
   and the insight block in `userPrompt`. Built OK.
4. **`refine.ts`** - rebuilt as single-call `generateDraftCandidates` with one
   `linePrompt` retry. Built OK.
5. **providers (5)** - switched to `generateDraftCandidates`; removed `insightRequired`
   forcing and per-provider retry/catch blocks. Built OK.
6. **`evaluator.ts` deleted; `index.ts` / `types.ts`** - exports updated; unused
   `insight` / `insightRequired` removed. Generation build + **20 tests pass**.
7. **`automation/draft.ts` + `ingest.ts`** - removed judge + `insightRequired`. Built OK.
8. **api wiring** - `app.ts`, `deps.ts`, routes `drafts.ts` / `ingest.ts` /
   `source-packets.ts`, and `lib/quality-judge.ts` (deleted) all de-judged. Built OK.
9. **Tests** - generation retry/scorer tests updated; `drafts-evaluate.test.ts` rewritten
   deterministic. Generation / automation / api suites **all green** (20/14/68).
10. **`CLAUDE.md`** - stale "280 enforced" + multi-pass text replaced.
11. **Final sweep** - worker & web builds pass; no lingering references to removed APIs.
