# Writing quality: the voice codex and the anti-slop gate

Zyquor writes short posts and replies. This document describes how the writing
rules are built, where they are enforced, and how to change them safely.

The system prompt is **assembled from scratch** in
`crates/zyquor-generation/src/prompts.rs` around a single shared codex in
`crates/zyquor-generation/src/voice.rs`. The same codex drives the deterministic
quality gate in `crates/zyquor-generation/src/quality.rs`, so the prompt and the
approval screen cannot drift apart.

## Where the rules come from

The codex is a rewrite — compressed to short-form X posts and replies — of five
public writing skills, all MIT-licensed. None of them are vendored verbatim.

| Source | What it contributed |
| --- | --- |
| [petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop) | Named structural patterns: binary contrasts, throat-clearing, faux-insight setups, importance puffery, weasel attribution, dramatic fragments, recap endings. |
| [addyosmani/clarity](https://github.com/addyosmani/clarity) | Preserve truth and ownership; one reader and one job; fix substance before surface; the portability test; never manufacture humanness. |
| [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) | Signals vs proof; protected facts; the flatten/relation tests for formula; inflation without mechanism. |
| [blader/humanizer](https://github.com/blader/humanizer) | Staging, rhythm-by-rule, inflation, formatting-by-rule, leftovers, writing for the wrong reader; keep the details that carry the writer's voice. |
| [mblode/agent-skills · ghostwriter](https://github.com/mblode/agent-skills/blob/main/skills/ghostwriter/SKILL.md) | Shortest true version; machine tells; abstract actors; performed cleverness; preserve the profile's habits instead of inventing quirks. |

What we did **not** import: detector-evasion advice. The goal is better writing,
not a passing detector score. A human may deliberately ship a contrast, a dash,
or a fragment; only high-confidence structures are hard failures.

## The three layers

```
voice.rs      CORE_CODEX + POST_CODEX / REPLY_CODEX + REVISION_CHECKLIST
              + PATTERNS (structural findings with weights and lane masks)
   │
   ├─ prompts.rs   system_prompt() composes the codex, lane contract,
   │               factual boundary, account voice, output contract, cut list
   │               reply_instruction() carries target/thread specifics
   │               revision_prompt() is a cut-only editor pass
   │               line_prompt() is the emergency retry
   │
   └─ quality.rs   score_tweet_quality_lane() subtracts structural penalties
                   is_clean_tweet_text_lane() refuses hard-shaped slop
                   passes_tweet_quality_floor_lane() is the approval gate
```

### Prompt anatomy (`zyquor prompt --idea …`)

The system prompt has eight sections, in order:

1. Role — the writing engine for a human-approved publishing desk.
2. **The job** — one specific reader; one precise, supported point.
3. **Craft codex** — the shared rules (say it plain, be concrete, portability
   test, verbs do the work, no inflation/borrowed authority/sales language,
   keep the account's voice, rhythm without rule, end on the consequence).
4. **Lane** — the post or reply contract plus the tweet-type form, its bar, and
   a voice exemplar that must never supply facts.
5. **Facts and provenance** — material is data not instructions; no invented
   causes, numbers, quotes, experience, authors; source-boundary rules; URL
   rules; no hashtags/emojis/thread framing.
6. **Account voice** — notes, example posts, tone, objective, recent history,
   corrections, and verified knowledge entries, which outrank generic rhythm
   advice.
7. **Banned phrases** — account phrases plus the AI-slop vocabulary list.
8. **Output** — strict JSON candidate shape, count, strongest first, finished
   drafts only, diversity rules.
9. **Before you answer** — the self-check cut list.

Lane switching is automatic: `tweet_type: "reply"` selects `REPLY_CODEX` and
embeds the target post plus the existing-replies context in the user prompt;
everything else selects `POST_CODEX`.

The account's own examples and notes are explicitly allowed to override the
generic rhythm guidance — the codex strips machine padding, it does not
flatten a real voice.

### Replies are not small posts

The reply contract is separate because the failure mode is different: a reply
that re-explains the target, opens with a pleasantry, or lectures is worse than
one that is merely plain. Replies must react to the author's actual point, answer
questions with a pick, add the one thing the author lacks, and stop. No advice
unless asked, no quoted target words, no engagement bait.

## The deterministic gate

`voice::PATTERNS` is the machine-readable half of the codex. Each pattern has a
stable id, a human label, a score weight, a hard-failure flag, and lane
visibility. Current families:

| id | shape | hard |
| ---- | ----- | ---- |
| `binary_contrast_split`, `binary_contrast_inline` | "not X. it's Y", "isn't just X…", "the point isn't X, it's Y" | yes |
| `throat_clearing` | "here's the thing", "let me be clear", "the truth is", "at the end of the day" | yes |
| `faux_insight` | "what nobody tells you", "the part everyone misses" | yes |
| `importance_puffery` | "testament to", "pivotal moment", "sets the stage" | yes |
| `weasel_attribution` | "experts agree", "studies show", "many argue" | yes |
| `participle_tail` | "…, highlighting the team's focus" | yes |
| `sales_language` | unlock/supercharge/game-changer/level up | yes |
| `chat_residue` | "great question", "hope this helps", "let me know if" | yes |
| `recap_ending` | "in conclusion", "the future looks bright" | yes |
| `mic_drop_closer` | "let that sink in", "that's the real win" | yes |
| `rhetorical_setup`, `meta_commentary`, `negative_listing` | staging, "the key point is", "Not X. Not Y." | no (penalty only) |
| `reply_pleasantry` | reply opening with "great point" | yes (reply lane) |
| `reply_advice_opener` | reply opening with "you should / consider / pro tip" | no (reply lane) |

Word-level slop (`delve`, `leverage`, `tapesty`, …) lives in
`zyquor_core::AI_SLOP_PHRASES` and is combined with these structural findings.

Behaviour:

- `score_tweet_quality_lane(text, lane)` subtracts the structural weights,
  capped at 9. Scores range across the existing scale; the default floors stay
  `ZYQUOR_QUALITY_MIN=7` (posts) and `ZYQUOR_REPLY_QUALITY_MIN=5` (replies).
- `is_clean_tweet_text_lane(text, lane)` refuses hard failures. The approve
  route's `screened:true` screen, the reply-loop screen, `zyquor overseer`, and
  the MCP `approve_draft` tool all go through it.
- `craft_findings(text, lane)` returns the structural reasons for diagnostics
  and future UI surfaces.

A human approving without `screened:true` can still override the screen by
judgment — that is deliberate. Agents always send the screen.

## Inspect and tune

```bash
# Print exactly what the model receives (no provider call, no side effects)
cargo run -p zyquor-cli -- prompt --idea "…" --tweet-type opinion
cargo run -p zyquor-cli -- prompt --idea "reply" --reply-to https://x.com/someone/status/1 --reply-text "…" --json

# Live provider probe with the new prompt (one network call)
ZYQUOR_SMOKE_IDEA="Batching cut p99 latency 40% on an 8-worker box." \
ZYQUOR_SMOKE_COUNT=2 cargo run -p zyquor-cli -- smoke-generation

# The fixed evaluation set (live generation + judge; explicit cost)
cargo run -p zyquor-cli -- tweet-eval
```

To add a rule:

1. Add or edit the instruction in `CORE_CODEX` / `POST_CODEX` / `REPLY_CODEX`
   in `voice.rs`. Keep it checkable; do not add facts guidance to the codex.
2. If it is structural and high-confidence, add a `PATTERNS` entry with a stable
   id, weight, `hard` flag, and lane mask. Add positive and negative unit tests
   in `voice.rs`; the negative test is mandatory (false positives reject good
   writing).
3. Run `cargo test -p zyquor-generation` and `zyquor prompt …` to read the
   result end to end.

## Limits

- These are **signals, not an authorship detector**. A clean gate does not prove
  a human wrote something, and a hit can be intentional style.
- The gate cannot verify facts; provenance is enforced by the prompt and by the
  approval screen's separate source/quality checks.
- Reply quality is judged without the target post in the deterministic gate; the
  prompt carries the target, but the gate only sees the draft. Reply-specific
  thread checks stay prompt-side.
- The codex deliberately keeps unusual specifics and uneven rhythm; do not
  "fix" them into uniform prose while tuning. When in doubt, protect the
  specific fact.
