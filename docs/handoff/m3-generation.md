# M3 task brief: finish `zyquor-generation`

## Done

- `crates/zyquor-generation/src/config.rs` — provider selection, model
  allowlists, `safe_*` fallbacks. Ported from `packages/generation/src/config.ts`.
  OpenRouter removed (see `docs/rust-migration.md` → Deliberate removals).
- `crates/zyquor-generation/src/quality.rs` — `score_tweet_quality`,
  `is_clean_tweet_text`, `passes_tweet_quality_floor`,
  `is_interrogation_dodge_reply`, `format_tweet_text`, `post_process_tweet_text`,
  `quality_minimum`, `reply_quality_minimum`.
- 16 tests; quality verified against TypeScript over 34 cases × 5 fields.

## Remaining

1. **`prompts.ts` (399 lines)** — pure string assembly, no I/O, so it ports
   cleanly. Port first and prove parity by rendering the same
   `GenerateDraftCandidatesInput` in both stacks and diffing the prompt text.
   Watch for: template literal whitespace (significant), `.toLowerCase()`
   locale differences, and the `tweetType` guidance table.
2. **`quality.ts` residue** — `parse_candidate_texts`, `candidates_from_text`,
   `parse_json_candidate_texts`, `is_no_candidates_error`, `as_text`,
   `is_grounded_candidate`, `strip_generated_urls`. These depend on
   `GenerateDraftCandidatesInput`; port the input type with the prompt work.
3. **Providers** — `command-code` and `opencode` shell out to CLIs; `gemini`
   and `ollama` are plain HTTP. Use `tokio::process::Command` and `reqwest`.
   - Provider parity is best proven with the `FetchLike` seam already present
     in TypeScript: the tests inject a fake fetch. Do the same with a Rust
     `trait Fetch` so tests need no network.
   - Do not add retries that TypeScript does not have. `Failed external post
     jobs are not auto-retried` is a product rule; the same caution applies to
     generation retries (there is exactly one line-prompt retry).
4. **`refine.ts`** — the revision-pass orchestration. Depends on the providers.
5. **`harness.ts`** — `renderSourceContext` and friends; pure, port alongside prompts.

## Exit criteria

- Same candidates (text + score object) for the same fixture input.
- `cargo test -p zyquor-generation` covers config, quality, prompts, and one
  provider against a fake transport.
- Update the M3 row in `docs/rust-migration.md`.

## Gotchas

- `candidates_from_text` de-duplicates on lowercased, whitespace-collapsed
  text and keeps the **first** occurrence; preserve ordering exactly.
- The scorer's `TECHNICAL_NOUNS` list counts matches with `\b`, so `GPUs`
  does not match `GPU`. Keep the word boundaries.
- Compiling ~40 regexes per call is currently intentional (readability). If
  you measure a problem, hoist them into `OnceLock` statics — but re-run the
  parity diff after doing so.
