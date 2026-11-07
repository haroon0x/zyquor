//! Write candidates with a single LLM call, plus an optional revision pass.
//! Ported from `packages/generation/src/refine.ts`.
//!
//! The full anti-slop guidance (voice rules, punctuation, style contract,
//! banned phrases, source boundary) lives in `system_prompt`/`user_prompt`, so
//! there is no need for separate insight, audit, reader-critique, or repair
//! passes. `revise` adds one cut-only editing pass on top: it can only remove
//! vagueness and unsupported claims, never add material, and never lowers a
//! candidate's quality score. If the model returns something we cannot parse
//! into candidates, retry once with the simpler `line_prompt` for robustness,
//! then fail loudly.

use std::future::Future;

use crate::parse::{candidates_from_text, combined_prompt, is_no_candidates_error};
use crate::prompts::{line_prompt, revision_prompt};
use crate::quality::normalize_count;
use crate::types::{GenerateDraftCandidatesInput, GeneratedDraftCandidate, GenerationResult};

/// Produces one model call for a prepared prompt. Implementations clone what
/// they need; the future may own the prompt outright.
pub async fn generate_draft_candidates<FInit, FPrompt, FutInit, FutPrompt>(
    generation_input: &GenerateDraftCandidatesInput,
    model: &str,
    provider_name: &str,
    mut run_initial: Option<FInit>,
    mut run_prompt: FPrompt,
    revise: bool,
) -> GenerationResult<Vec<GeneratedDraftCandidate>>
where
    FInit: FnMut(GenerateDraftCandidatesInput) -> FutInit,
    FutInit: Future<Output = GenerationResult<String>>,
    FPrompt: FnMut(String) -> FutPrompt,
    FutPrompt: Future<Output = GenerationResult<String>>,
{
    let initial = match &mut run_initial {
        Some(run) => run(generation_input.clone()).await?,
        None => run_prompt(combined_prompt(generation_input)).await?,
    };

    let mut candidates =
        match candidates_from_text(&initial, generation_input, provider_name, model) {
            Ok(candidates) => candidates,
            Err(error) => {
                if !is_no_candidates_error(&error, provider_name) {
                    // Provider-level failure (empty output): usually a transient
                    // fault, so give the full prompt one more attempt before
                    // giving up.
                    let retry = run_prompt(combined_prompt(generation_input)).await?;
                    candidates_from_text(&retry, generation_input, provider_name, model)?
                } else {
                    // Kept the reply but it gives no usable candidates: retry once
                    // with the simpler line prompt, then fail loudly.
                    let line_retry = run_prompt(line_prompt(generation_input)).await?;
                    candidates_from_text(&line_retry, generation_input, provider_name, model)?
                }
            }
        };

    // Best-of-N top-up: when the model returns fewer candidates than requested,
    // repeat full-prompt attempts nudged with the texts already drafted, merging
    // unique results, so a large pool fills with distinct new angles instead of
    // regenerating the same few. Bounded: at most 4 extra passes (1 when the
    // target is 3 or fewer), each pass is opportunistic on error.
    let target_count = normalize_count(generation_input.count);
    let max_top_ups = if target_count <= 3 { 1 } else { 4 };
    for _ in 0..max_top_ups {
        if candidates.len() >= target_count {
            break;
        }
        let base_prompt = combined_prompt(generation_input);
        let prompt = if candidates.is_empty() || target_count <= 3 {
            base_prompt
        } else {
            let already = candidates
                .iter()
                .map(|candidate| {
                    let end = candidate
                        .text
                        .char_indices()
                        .nth(140)
                        .map(|(index, _)| index)
                        .unwrap_or(candidate.text.len());
                    format!("- {}", &candidate.text[..end])
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "{base_prompt}\n\nAlready drafted (do not reuse or closely rephrase any of these; each new candidate must be a genuinely different angle. Aim for {} more distinct candidates):\n{already}",
                target_count - candidates.len()
            )
        };
        let Ok(extra_raw) = run_prompt(prompt).await else {
            // Top-up is opportunistic; keep whatever earlier passes produced.
            break;
        };
        let Ok(extra) = candidates_from_text(&extra_raw, generation_input, provider_name, model)
        else {
            break;
        };
        let mut seen: std::collections::HashSet<String> = candidates
            .iter()
            .map(|candidate| candidate.text.clone())
            .collect();
        for candidate in extra {
            if candidates.len() >= target_count {
                break;
            }
            if !candidate.text.is_empty() && seen.insert(candidate.text.clone()) {
                candidates.push(candidate);
            }
        }
    }

    if !revise || candidates.is_empty() {
        return Ok(candidates);
    }

    // Revision is an enhancement, never a failure point: any error falls back
    // to the first-pass drafts, and a revised draft only replaces the original
    // when it survives the same quality pipeline and scores at least as high.
    let texts: Vec<String> = candidates
        .iter()
        .map(|candidate| candidate.text.clone())
        .collect();
    let Ok(revised_raw) = run_prompt(revision_prompt(generation_input, &texts)).await else {
        return Ok(candidates);
    };
    let Ok(revised) = candidates_from_text(&revised_raw, generation_input, provider_name, model)
    else {
        return Ok(candidates);
    };
    Ok(candidates
        .into_iter()
        .enumerate()
        .map(|(index, original)| match revised.get(index) {
            Some(better) if better.text != original.text && better.quality >= original.quality => {
                better.clone()
            }
            _ => original,
        })
        .collect())
}
