# M3 task brief: finish `zyquor-generation`

## Done

- `crates/zyquor-generation/src/config.rs` — provider selection, model
  allowlists, `safe_*` fallbacks. Ported from `packages/generation/src/config.ts`.
  OpenRouter removed (see `docs/rust-migration.md` → Deliberate removals).
- `crates/zyquor-generation/src/quality.rs` — `score_tweet_quality`,
  `is_clean_tweet_text`, `passes_tweet_quality_floor`,
  `is_interrogation_dodge_reply`, `format_tweet_text`, `post_process_tweet_text`,
  `quality_minimum`, `reply_quality_minimum`.
- **`prompts.rs` + `harness.rs` + `types.rs`** — `system_prompt`, `user_prompt`,
  `revision_prompt`, `line_prompt`, `tweet_type_instruction`, and
  `render_source_context` / `build_source_tweet_input`. All 32 rendered prompts
  (8 request shapes × 4 builders) are byte-identical to the TypeScript output;
  see "Parity harnesses" below.
- `crates/zyquor-generation/src/parse.rs` — `parse_candidate_texts`,
  `candidates_from_text`, `parse_json_candidate_texts`, `is_no_candidates_error`,
  `as_text`, and the private `is_grounded_candidate` / `strip_generated_urls`
  helpers, ported from the tail of `quality.ts`.
- Workspace now at 105 tests (config, quality, prompts, plus fake-`Fetch`
  tests for the HTTP providers and the `post_json` retry path; no test touches
  the network). Parsing has no dedicated tests yet. Quality was verified
  against TypeScript over 34 cases × 5 fields.

## Notes for the next milestone

Nothing open in this crate. `zyquor-adapters` and `zyquor-automation` are the
remaining M3 crates. Live verification 2026-11-06: opencode (`run -m
opencode/glm-5.3-flash-free#high`) produced a parseable, quality-scored
candidate in ~21s via the Rust client (`cargo run -p zyquor-generation
--example live_smoke`); ollama against the local `qwen2.5:0.5b` failed with
"no draft candidates" in both Rust and TypeScript (the 0.5B model's output
does not pass the quality gate), matching on both stacks. Gemini and
command-code have not been exercised live; verify them through the same
example before the TypeScript `providers/` tree is retired.

## Port details (nothing open in this crate)

1. ~~**`prompts.ts`**~~ — done, see above. `prompts.rs` / `harness.rs` /
   `types.rs`. Add new request shapes to `scripts/prompt-parity.mjs` and
   `crates/zyquor-generation/examples/prompt_parity.rs` together so the diff
   stays meaningful.
2. ~~**`quality.ts` residue**~~ — done in `parse.rs` (see above). Parsing
   ships without Rust tests for now — TypeScript test files are not ported to
   Rust (see "Test policy" in `docs/rust-migration.md`).
3. ~~**Providers**~~ — done. `crates/zyquor-generation/src/providers/`:
   `http.rs` (`Fetch` seam, `post_json` with the TypeScript retry policy —
   retryable statuses only, `retry-after`/`x-ratelimit-reset` backoff — plus
   `ReqwestFetch` for production and `SleepFn` for tests), `cli_env.rs`
   (ZYQUOR_-filtered child env), `cli.rs` (shared spawn/capture: temp-dir cwd,
   combined stdout+stderr byte cap with kill, wall-clock timeout, `cmd /C`
   shim on Windows, `ZYQUOR_LLM_DEBUG=1` artifact capture with the
   `YYYY-MM-DDTHH-MM-SS-mmmZ` stamp), and `command_code.rs`, `opencode.rs`
   (failover ladder on the CLI's rate-limit/unavailable shutters only, plus
   the exit-code-1-with-usable-JSON leniency), `gemini.rs`, `ollama.rs`
   (with `strip_thinking`). Providers take a `Fetch` argument; tests use a
   fake `Fetch`, so the suite never touches the network. Live check
   2026-11-06: `opencode run -m opencode/glm-5.3-flash-free#high` produced a
   parseable, quality-scored candidate in ~21s via the Rust client
   (`cargo run -p zyquor-generation --example live_smoke`).
4. ~~**`refine.ts`**~~ — done in `crates/zyquor-generation/src/refine.rs`
   (initial + no-candidates line-prompt retry, best-of-N top-up, revision
   pass). The `createGenerationProviderFromEnv` factory is ported to
   `providers/mod.rs` (`create_generation_provider_from_env`).
5. ~~**`harness.ts`**~~ — done in `harness.rs`
   (`render_source_context`, `build_source_tweet_input`).

## Exit criteria

- The existing `zyquor-generation` tests stay green; providers build and run
  with no network access required for the crate's test suite.
- `parse.rs` fixtures/tests are not an exit blocker (see "Test policy" in
  `docs/rust-migration.md`).
- Update the M3 row in `docs/rust-migration.md`.

## Gotchas

- `candidates_from_text` de-duplicates on lowercased, whitespace-collapsed
  text and keeps the **first** occurrence; preserve ordering exactly.
- The scorer's `TECHNICAL_NOUNS` list counts matches with `\b`, so `GPUs`
  does not match `GPU`. Keep the word boundaries.
- Compiling ~40 regexes per call is currently intentional (readability). If
  you measure a problem, hoist them into `OnceLock` statics — but re-run the
  parity diff after doing so.
